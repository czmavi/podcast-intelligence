import { assertEquals } from "@std/assert";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { setSpeakerClusterIgnored } from "./speaker-ignore.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: hlas lze ignorovat a znovu vrátit mezi nepřiřazené",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const clusterId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const clusterUtteranceId = crypto.randomUUID();
    const manualUtteranceId = crypto.randomUUID();
    const vector = `[${[1, ...Array<number>(255).fill(0)].join(",")}]`;
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Speaker ignore test',
          ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO persons (id, display_name, normalized_name)
        VALUES (${personId}, 'Ignorovaný hlas', 'ignorovany hlas')
      `;
      await sql`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${podcastId}, ${personId}, 'guest')
      `;
      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, audio_url, processing_status
        ) VALUES (
          ${episodeId}, ${podcastId}, 'speaker-ignore', 'Speaker ignore',
          'https://example.test/audio.mp3', 'ready'
        )
      `;
      await sql`
        INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
        VALUES (${runId}, ${episodeId}, 'completed', 'integration')
      `;
      await sql`
        UPDATE episodes SET active_processing_run_id = ${runId} WHERE id = ${episodeId}
      `;
      await sql`
        INSERT INTO speaker_clusters (
          id, episode_id, processing_run_id, local_label, total_speech_seconds,
          segment_count, assigned_person_id, identity_status, identity_source
        ) VALUES (
          ${clusterId}, ${episodeId}, ${runId}, 'SPEAKER_00', 20, 2,
          ${personId}, 'verified', 'manual'
        )
      `;
      await sql`
        INSERT INTO utterances (
          id, episode_id, processing_run_id, speaker_cluster_id, person_id,
          speaker_assignment_source, sequence_number, start_seconds, end_seconds, text
        ) VALUES
          (${clusterUtteranceId}, ${episodeId}, ${runId}, ${clusterId}, ${personId},
            'cluster', 0, 0, 10, 'Clusterové přiřazení.'),
          (${manualUtteranceId}, ${episodeId}, ${runId}, ${clusterId}, ${personId},
            'manual', 1, 10, 20, 'Ruční override.')
      `;
      await sql`
        INSERT INTO speaker_embeddings (
          processing_run_id, person_id, speaker_cluster_id, model_name, embedding,
          dimensions, source_type, is_verified
        ) VALUES (
          ${runId}, ${personId}, ${clusterId}, 'test-model', ${vector}::vector,
          256, 'verified_cluster', true
        )
      `;

      assertEquals(await setSpeakerClusterIgnored(sql, clusterId, true), {
        clusterId,
        ignored: true,
      });
      assertEquals(await setSpeakerClusterIgnored(sql, clusterId, true), {
        clusterId,
        ignored: true,
      });
      assertEquals(
        (await sql`
          SELECT assigned_person_id, identity_status, identity_source
          FROM speaker_clusters WHERE id = ${clusterId}
        `)[0],
        {
          assignedPersonId: null,
          identityStatus: "ignored",
          identitySource: "manual_ignore",
        },
      );
      assertEquals(
        (await sql`
          SELECT id, person_id, speaker_assignment_source
          FROM utterances WHERE speaker_cluster_id = ${clusterId}
          ORDER BY sequence_number
        `).map((utterance) => ({
          id: String(utterance.id),
          personId: utterance.personId ? String(utterance.personId) : null,
          source: utterance.speakerAssignmentSource,
        })),
        [
          { id: clusterUtteranceId, personId: null, source: "cluster" },
          { id: manualUtteranceId, personId, source: "manual" },
        ],
      );
      assertEquals(
        (await sql`
          SELECT person_id, is_verified, source_type
          FROM speaker_embeddings WHERE speaker_cluster_id = ${clusterId}
        `)[0],
        { personId: null, isVerified: false, sourceType: "cluster_centroid" },
      );
      assertEquals(
        (await sql`
          SELECT
            count(*) FILTER (WHERE identity_status <> 'ignored')::int AS visible_total,
            count(*) FILTER (
              WHERE identity_status NOT IN ('verified', 'ignored')
            )::int AS pending
          FROM speaker_clusters
          WHERE episode_id = ${episodeId} AND processing_run_id = ${runId}
        `)[0],
        { visibleTotal: 0, pending: 0 },
      );

      assertEquals(await setSpeakerClusterIgnored(sql, clusterId, false), {
        clusterId,
        ignored: false,
      });
      assertEquals(
        (await sql`
          SELECT assigned_person_id, identity_status, identity_source
          FROM speaker_clusters WHERE id = ${clusterId}
        `)[0],
        { assignedPersonId: null, identityStatus: "unknown", identitySource: null },
      );
      assertEquals(
        Number(
          (await sql`
          SELECT count(*)::int AS pending
          FROM speaker_clusters
          WHERE episode_id = ${episodeId}
            AND identity_status NOT IN ('verified', 'ignored')
        `)[0]?.pending,
        ),
        1,
      );
    } finally {
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql`DELETE FROM persons WHERE id = ${personId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
