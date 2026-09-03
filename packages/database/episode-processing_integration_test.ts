import { assertEquals } from "@std/assert";
import { createDatabase } from "./client.ts";
import { scheduleEpisode, scheduleNextAutoProcessEpisode } from "./episode-processing.ts";
import { loadConfig } from "../shared/config.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: autopilot ignoruje prefetch frontu a atomicky zařadí vhodnou epizodu",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const olderEpisodeId = crypto.randomUUID();
    const newerEpisodeId = crypto.randomUUID();
    const failedEpisodeId = crypto.randomUUID();
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url, auto_process_enabled)
        VALUES (${podcastId}, 'Autopilot test', ${`https://example.test/${podcastId}.xml`}, true)
      `;
      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, published_at, audio_url, processing_status
        ) VALUES
          (${olderEpisodeId}, ${podcastId}, 'older', 'Starší', '2025-01-01',
            'https://example.test/older.mp3', 'imported'),
          (${newerEpisodeId}, ${podcastId}, 'newer', 'Novější', '2025-02-01',
            'https://example.test/newer.mp3', 'imported'),
          (${failedEpisodeId}, ${podcastId}, 'failed', 'Chybná', '2025-03-01',
            'https://example.test/failed.mp3', 'failed')
      `;
      await sql`
        INSERT INTO jobs (type, entity_type, entity_id, payload, priority, max_attempts)
        VALUES (
          'DOWNLOAD_AUDIO', 'episode', ${olderEpisodeId},
          '{"continuePipeline":false,"source":"bulk_prefetch"}'::jsonb, -20, 3
        )
      `;

      const attempts = await Promise.all([
        scheduleNextAutoProcessEpisode(sql, 3),
        scheduleNextAutoProcessEpisode(sql, 3),
      ]);
      const scheduled = attempts.filter((item) => item !== null);
      assertEquals(scheduled.length, 1);
      assertEquals(scheduled[0]?.episodeId, newerEpisodeId);
      assertEquals(scheduled[0]?.type, "DOWNLOAD_AUDIO");
      assertEquals(await scheduleNextAutoProcessEpisode(sql, 3), null);
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id IN (
        ${olderEpisodeId}, ${newerEpisodeId}, ${failedEpisodeId}
      )`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: "integration: audio job snapshotuje ASR režim pro retry",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url, transcript_alignment_mode)
        VALUES (
          ${podcastId}, 'ASR mode snapshot', ${`https://example.test/${podcastId}.xml`},
          'overlap_asr_corrected'
        )
      `;
      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, audio_url, processing_status,
          original_audio_path, normalized_audio_path
        ) VALUES (
          ${episodeId}, ${podcastId}, 'snapshot', 'Snapshot',
          'https://example.test/audio.mp3', 'normalized', '/data/original.mp3', '/data/audio.wav'
        )
      `;
      const scheduled = await scheduleEpisode(sql, episodeId, 3, "full");
      await sql`
        UPDATE podcasts SET transcript_alignment_mode = 'segment' WHERE id = ${podcastId}
      `;
      const rows = await sql`SELECT payload FROM jobs WHERE id = ${scheduled.jobId}`;
      assertEquals(rows[0]?.payload, {
        force: true,
        transcriptAlignmentMode: "overlap_asr_corrected",
      });
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ${episodeId}`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
