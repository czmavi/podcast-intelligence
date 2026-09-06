import type { AssignSpeakerInput } from "../domain/schemas.ts";
import { DomainError, NotFoundError } from "../domain/errors.ts";
import type { Sql } from "./client.ts";
import { requireSelectedTranscript } from "./transcript-selection.ts";

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs").trim()
    .replace(/\s+/g, " ");
}

export interface SpeakerAssignmentResult {
  personId: string;
  personCreated: boolean;
}

export async function assignSpeaker(
  sql: Sql,
  clusterId: string,
  input: AssignSpeakerInput,
): Promise<SpeakerAssignmentResult> {
  return await sql.begin(async (tx) => {
    const cluster = (await tx`
      SELECT cluster.id, cluster.episode_id, cluster.processing_run_id, cluster.assigned_person_id, episode.podcast_id
      FROM speaker_clusters cluster
      JOIN episodes episode ON episode.id = cluster.episode_id
      WHERE cluster.id = ${clusterId}
      FOR UPDATE OF episode
    `)[0];
    if (!cluster) throw new NotFoundError("Speaker cluster");
    await requireSelectedTranscript(tx, cluster.episodeId, cluster.processingRunId);

    const podcastRole =
      input.assignmentType === "moderator" || input.assignmentType === "newModerator"
        ? "moderator"
        : "guest";
    let personId: string;
    let personCreated = false;
    if (input.assignmentType === "newGuest" || input.assignmentType === "newModerator") {
      const person = (await tx`
        INSERT INTO persons (display_name, normalized_name, description, is_regular_host)
        VALUES (${input.displayName}, ${normalizedName(input.displayName)},
          ${input.description ?? null}, ${input.assignmentType === "newModerator"})
        RETURNING id
      `)[0];
      if (!person) throw new Error("Novou osobu se nepodařilo vytvořit.");
      personId = String(person.id);
      personCreated = true;
      await tx`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${cluster.podcastId}, ${personId}, ${podcastRole})
      `;
    } else {
      const person = (await tx`
        SELECT person.id, association.role
        FROM persons person
        JOIN podcast_persons association
          ON association.person_id = person.id
          AND association.podcast_id = ${cluster.podcastId}
        WHERE person.id = ${input.personId}
      `)[0];
      if (!person) throw new NotFoundError("Osoba");
      if (input.assignmentType === "moderator" && person.role !== "moderator") {
        throw new DomainError(
          "Vybraná osoba není v tomto podcastu vedená jako moderátor.",
          "SPEAKER_ROLE_MISMATCH",
          400,
        );
      }
      if (input.assignmentType === "guest" && person.role !== "guest") {
        throw new DomainError(
          "Moderátora tohoto podcastu vyberte v režimu Moderátor.",
          "SPEAKER_ROLE_MISMATCH",
          400,
        );
      }
      personId = String(person.id);
    }

    if (
      cluster.assignedPersonId && String(cluster.assignedPersonId) !== personId && !input.overwrite
    ) {
      throw new DomainError(
        "Cluster je přiřazen jiné osobě; nastavte overwrite=true.",
        "IDENTITY_OVERWRITE_REQUIRED",
        409,
      );
    }

    await tx`
      UPDATE speaker_clusters
      SET assigned_person_id = ${personId},
        identity_status = ${input.verified ? "verified" : "suggested"},
        identity_confidence = ${input.verified ? 1 : null},
        identity_source = 'manual',
        updated_at = now()
      WHERE id = ${clusterId}
    `;
    await tx`
      UPDATE utterances
      SET person_id = ${personId}
      WHERE speaker_cluster_id = ${clusterId}
        AND speaker_assignment_source = 'cluster'
    `;
    if (input.createReferenceEmbeddings && input.verified) {
      await tx`
        UPDATE speaker_embeddings
        SET person_id = ${personId}, is_verified = true, source_type = 'verified_cluster'
        WHERE speaker_cluster_id = ${clusterId}
      `;
    }
    await tx`
      INSERT INTO episode_participants (episode_id, person_id, role, source, confidence)
      VALUES (
        ${cluster.episodeId},
        ${personId},
        ${podcastRole},
        'manual',
        1
      )
      ON CONFLICT (episode_id, person_id)
      DO UPDATE SET role = EXCLUDED.role, source = 'manual', confidence = 1
    `;

    return { personId, personCreated };
  });
}
