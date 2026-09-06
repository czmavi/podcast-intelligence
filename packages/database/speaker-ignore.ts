import { NotFoundError } from "../domain/errors.ts";
import type { Sql } from "./client.ts";
import { requireSelectedTranscript } from "./transcript-selection.ts";

export interface SpeakerIgnoreResult {
  clusterId: string;
  ignored: boolean;
}

export async function setSpeakerClusterIgnored(
  sql: Sql,
  clusterId: string,
  ignored: boolean,
): Promise<SpeakerIgnoreResult> {
  return await sql.begin(async (tx) => {
    const cluster = (await tx`
      SELECT cluster.id, cluster.identity_status, cluster.episode_id, cluster.processing_run_id
      FROM speaker_clusters cluster JOIN episodes episode ON episode.id = cluster.episode_id
      WHERE cluster.id = ${clusterId}
      FOR UPDATE OF episode
    `)[0];
    if (!cluster) throw new NotFoundError("Speaker cluster");
    await requireSelectedTranscript(tx, cluster.episodeId, cluster.processingRunId);

    if (ignored) {
      await tx`
        UPDATE speaker_clusters
        SET assigned_person_id = NULL,
          identity_status = 'ignored',
          identity_confidence = NULL,
          identity_source = 'manual_ignore',
          updated_at = now()
        WHERE id = ${clusterId}
      `;
      await tx`
        UPDATE utterances
        SET person_id = NULL
        WHERE speaker_cluster_id = ${clusterId}
          AND speaker_assignment_source = 'cluster'
      `;
      await tx`
        UPDATE speaker_embeddings
        SET person_id = NULL,
          is_verified = false,
          source_type = 'cluster_centroid'
        WHERE speaker_cluster_id = ${clusterId}
          AND source_type IN ('cluster_centroid', 'verified_cluster')
      `;
      await tx`
        DELETE FROM speaker_identity_candidates
        WHERE speaker_cluster_id = ${clusterId}
      `;
    } else if (cluster.identityStatus === "ignored") {
      await tx`
        UPDATE speaker_clusters
        SET identity_status = 'unknown',
          identity_confidence = NULL,
          identity_source = NULL,
          updated_at = now()
        WHERE id = ${clusterId}
      `;
    }

    return { clusterId, ignored };
  });
}
