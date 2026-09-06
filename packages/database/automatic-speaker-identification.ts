import type { Sql } from "./client.ts";
import type { IdentifiedGuest } from "../speakers/guest-identification.ts";
import { JobRepository } from "./repositories/jobs.ts";

export interface SingleUnknownSpeakerContext {
  episodeId: string;
  clusterId: string;
  title: string;
  description: string | null;
  knownModeratorNames: string[];
}

export interface AutomaticGuestAssignmentResult {
  status: "assigned" | "skipped_changed" | "skipped_role_conflict";
  clusterId: string;
  personId: string | null;
  personCreated: boolean;
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs").trim()
    .replace(/\s+/g, " ");
}

export async function enqueueGuestIdentificationAfterSpeakerAssignment(
  sql: Sql,
  clusterId: string,
  maxAttempts: number,
): Promise<string | null> {
  const rows = await sql`
    SELECT episode.id
    FROM speaker_clusters assigned_cluster
    JOIN episodes episode
      ON episode.id = assigned_cluster.episode_id
      AND episode.active_processing_run_id = assigned_cluster.processing_run_id
    JOIN podcast_persons moderator
      ON moderator.podcast_id = episode.podcast_id
      AND moderator.person_id = assigned_cluster.assigned_person_id
      AND moderator.role = 'moderator'
    WHERE assigned_cluster.id = ${clusterId}
      AND NOT episode.transcript_selection_pending
      AND assigned_cluster.identity_status = 'verified'
      AND (
        SELECT count(*)
        FROM speaker_clusters remaining_cluster
        WHERE remaining_cluster.episode_id = episode.id
          AND remaining_cluster.processing_run_id = episode.active_processing_run_id
          AND remaining_cluster.assigned_person_id IS NULL
          AND remaining_cluster.identity_status = 'unknown'
      ) = 1
  `;
  if (!rows[0]) return null;
  return await new JobRepository(sql).enqueue(
    "IDENTIFY_SPEAKERS",
    "episode",
    String(rows[0].id),
    {
      continuePipeline: false,
      nonBlocking: true,
      source: "manual_moderator_assignment",
    },
    10,
    maxAttempts,
  );
}

export async function singleUnknownSpeakerContext(
  sql: Sql,
  episodeId: string,
): Promise<SingleUnknownSpeakerContext | null> {
  const rows = await sql`
    SELECT episode.id AS episode_id, episode.title, episode.description,
      array_agg(cluster.id ORDER BY cluster.local_label) FILTER (
        WHERE cluster.assigned_person_id IS NULL AND cluster.identity_status = 'unknown'
      ) AS cluster_ids,
      (
        SELECT array_agg(person.display_name ORDER BY person.display_name)
        FROM podcast_persons association
        JOIN persons person ON person.id = association.person_id
        WHERE association.podcast_id = episode.podcast_id
          AND association.role = 'moderator'
      ) AS moderator_names
    FROM episodes episode
    JOIN speaker_clusters cluster
      ON cluster.episode_id = episode.id
      AND cluster.processing_run_id = episode.active_processing_run_id
    WHERE episode.id = ${episodeId}
      AND NOT episode.transcript_selection_pending
    GROUP BY episode.id
  `;
  const row = rows[0];
  const clusterIds = row?.clusterIds as unknown[] | undefined;
  if (!row || clusterIds?.length !== 1 || !clusterIds[0]) return null;
  return {
    episodeId: String(row.episodeId),
    clusterId: String(clusterIds[0]),
    title: String(row.title),
    description: row.description === null ? null : String(row.description),
    knownModeratorNames: ((row.moderatorNames as unknown[] | null) ?? []).map(String),
  };
}

export async function assignSingleUnknownGuest(
  sql: Sql,
  context: SingleUnknownSpeakerContext,
  guest: IdentifiedGuest,
): Promise<AutomaticGuestAssignmentResult> {
  return await sql.begin(async (tx) => {
    const unknownClusters = await tx`
      SELECT cluster.id, episode.podcast_id
      FROM speaker_clusters cluster
      JOIN episodes episode
        ON episode.id = cluster.episode_id
        AND episode.active_processing_run_id = cluster.processing_run_id
      WHERE cluster.episode_id = ${context.episodeId}
        AND NOT episode.transcript_selection_pending
        AND cluster.assigned_person_id IS NULL
        AND cluster.identity_status = 'unknown'
      ORDER BY cluster.local_label
      FOR UPDATE OF episode
    `;
    if (
      unknownClusters.length !== 1 ||
      String(unknownClusters[0]?.id) !== context.clusterId
    ) {
      return {
        status: "skipped_changed",
        clusterId: context.clusterId,
        personId: null,
        personCreated: false,
      };
    }

    const normalized = normalizedName(guest.displayName);
    let person = (await tx`
      SELECT id FROM persons
      WHERE normalized_name = ${normalized}
      ORDER BY created_at, id
      LIMIT 1
    `)[0];
    let personCreated = false;
    if (!person) {
      person = (await tx`
        INSERT INTO persons (display_name, normalized_name, is_regular_host)
        VALUES (${guest.displayName}, ${normalized}, false)
        RETURNING id
      `)[0];
      personCreated = true;
    }
    if (!person) throw new Error("Hosta se nepodařilo vytvořit ani dohledat.");
    const personId = String(person.id);

    await tx`
      INSERT INTO podcast_persons (podcast_id, person_id, role)
      VALUES (${unknownClusters[0]?.podcastId}, ${personId}, 'guest')
      ON CONFLICT (podcast_id, person_id) DO NOTHING
    `;
    const association = (await tx`
      SELECT role
      FROM podcast_persons
      WHERE podcast_id = ${unknownClusters[0]?.podcastId}
        AND person_id = ${personId}
    `)[0];
    if (association?.role !== "guest") {
      return {
        status: "skipped_role_conflict",
        clusterId: context.clusterId,
        personId: null,
        personCreated,
      };
    }

    await tx`
      UPDATE speaker_clusters
      SET assigned_person_id = ${personId}, identity_status = 'verified',
        identity_confidence = ${guest.confidence}, identity_source = 'llm_episode_metadata',
        updated_at = now()
      WHERE id = ${context.clusterId}
    `;
    await tx`
      UPDATE utterances
      SET person_id = ${personId}
      WHERE speaker_cluster_id = ${context.clusterId}
        AND speaker_assignment_source = 'cluster'
    `;
    await tx`
      INSERT INTO episode_participants (episode_id, person_id, role, source, confidence)
      VALUES (${context.episodeId}, ${personId}, 'guest', 'llm', ${guest.confidence})
      ON CONFLICT (episode_id, person_id)
      DO UPDATE SET role = 'guest', source = 'llm', confidence = EXCLUDED.confidence
      WHERE episode_participants.source <> 'manual'
    `;
    return {
      status: "assigned",
      clusterId: context.clusterId,
      personId,
      personCreated,
    };
  });
}
