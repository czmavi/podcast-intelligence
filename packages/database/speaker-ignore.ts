import { NotFoundError } from "../domain/errors.ts";
import type { Sql } from "./client.ts";

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
      SELECT id, identity_status
      FROM speaker_clusters
      WHERE id = ${clusterId}
      FOR UPDATE
    `)[0];
    if (!cluster) throw new NotFoundError("Speaker cluster");

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
