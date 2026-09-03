import { assertEquals } from "@std/assert";
import { createDatabase } from "./client.ts";
import { suggestRegularHostsForEpisode } from "./speaker-matching.ts";
import { loadConfig } from "../shared/config.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: hlasový matching pouze navrhne stálého moderátora ze stejného podcastu",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const referenceEpisodeId = crypto.randomUUID();
    const targetEpisodeId = crypto.randomUUID();
    const referenceRunId = crypto.randomUUID();
    const targetRunId = crypto.randomUUID();
    const referenceClusterId = crypto.randomUUID();
    const targetClusterId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const vector = `[${[1, ...Array<number>(255).fill(0)].join(",")}]`;
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Voice match test', ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO persons (id, display_name, normalized_name, is_regular_host)
        VALUES (${personId}, 'Testovací moderátor', 'testovaci moderator', true)
      `;
      await sql`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${podcastId}, ${personId}, 'moderator')
      `;
      await sql`
        INSERT INTO episodes (id, podcast_id, external_id, title, audio_url, processing_status)
        VALUES
          (${referenceEpisodeId}, ${podcastId}, 'reference', 'Reference',
            'https://example.test/reference.mp3', 'ready'),
          (${targetEpisodeId}, ${podcastId}, 'target', 'Target',
            'https://example.test/target.mp3', 'transcribed')
      `;
      await sql`
        INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
        VALUES
          (${referenceRunId}, ${referenceEpisodeId}, 'completed', 'test'),
          (${targetRunId}, ${targetEpisodeId}, 'completed', 'test')
      `;
      await sql`
        UPDATE episodes SET active_processing_run_id = CASE
          WHEN id = ${referenceEpisodeId} THEN ${referenceRunId}::uuid
          ELSE ${targetRunId}::uuid END
        WHERE id IN (${referenceEpisodeId}, ${targetEpisodeId})
      `;
      await sql`
        INSERT INTO speaker_clusters (
          id, episode_id, processing_run_id, local_label, total_speech_seconds,
          segment_count, assigned_person_id, identity_status
        ) VALUES
          (${referenceClusterId}, ${referenceEpisodeId}, ${referenceRunId}, 'SPEAKER_00',
            60, 10, ${personId}, 'verified'),
          (${targetClusterId}, ${targetEpisodeId}, ${targetRunId}, 'SPEAKER_00',
            60, 10, NULL, 'unknown')
      `;
      await sql`
        INSERT INTO speaker_embeddings (
          processing_run_id, person_id, speaker_cluster_id, model_name, embedding,
          dimensions, source_type, duration_seconds, is_verified
        ) VALUES
          (${referenceRunId}, ${personId}, ${referenceClusterId}, 'test-model',
            ${vector}::vector, 256, 'verified_cluster', 60, true),
          (${targetRunId}, NULL, ${targetClusterId}, 'test-model',
            ${vector}::vector, 256, 'cluster_centroid', 60, false)
      `;

      const suggestions = await suggestRegularHostsForEpisode(sql, targetEpisodeId);
      assertEquals(suggestions.length, 1);
      assertEquals(suggestions[0]?.personId, personId);
      const clusters = await sql`
        SELECT assigned_person_id, identity_status, identity_source
        FROM speaker_clusters WHERE id = ${targetClusterId}
      `;
      assertEquals(String(clusters[0]?.assignedPersonId), personId);
      assertEquals(clusters[0]?.identityStatus, "suggested");
      assertEquals(clusters[0]?.identitySource, "automatic_voice_match");
    } finally {
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql`DELETE FROM persons WHERE id = ${personId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
