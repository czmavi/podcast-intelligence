import { assertEquals } from "@std/assert";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { scheduleMissingPodcastDownloads } from "./episode-processing.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: hromadné stažení zařadí pouze dostupná chybějící audia",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const firstEpisodeId = crypto.randomUUID();
    const failedEpisodeId = crypto.randomUUID();
    const unavailableEpisodeId = crypto.randomUUID();
    const downloadedEpisodeId = crypto.randomUUID();
    const excludedEpisodeId = crypto.randomUUID();
    const episodeIds = [
      firstEpisodeId,
      failedEpisodeId,
      unavailableEpisodeId,
      downloadedEpisodeId,
      excludedEpisodeId,
    ];
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Bulk download test', ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, audio_url, processing_status,
          is_present_in_feed, original_audio_path, rag_excluded
        ) VALUES
          (${firstEpisodeId}, ${podcastId}, 'first', 'První',
            'https://example.test/first.mp3', 'imported', true, NULL, false),
          (${failedEpisodeId}, ${podcastId}, 'failed', 'Chybná',
            'https://example.test/failed.mp3', 'failed', true, NULL, false),
          (${unavailableEpisodeId}, ${podcastId}, 'unavailable', 'Mimo RSS',
            'https://example.test/unavailable.mp3', 'imported', false, NULL, false),
          (${downloadedEpisodeId}, ${podcastId}, 'downloaded', 'Stažená',
            'https://example.test/downloaded.mp3', 'downloaded', true,
            '/data/already-downloaded.mp3', false),
          (${excludedEpisodeId}, ${podcastId}, 'excluded', 'Vyloučená',
            'https://example.test/excluded.mp3', 'imported', true, NULL, true)
      `;

      assertEquals(await scheduleMissingPodcastDownloads(sql, podcastId, 4), {
        podcastId,
        eligibleCount: 2,
        queuedCount: 2,
        alreadyQueuedCount: 0,
      });
      const queued = await sql`
        SELECT entity_id, priority, max_attempts, payload
        FROM jobs
        WHERE type = 'DOWNLOAD_AUDIO' AND entity_id = ANY(${episodeIds}::uuid[])
        ORDER BY entity_id
      `;
      assertEquals(queued.length, 2);
      assertEquals(queued.every((job) => job.priority === -20 && job.maxAttempts === 4), true);
      assertEquals(
        queued.every((job) =>
          job.payload.continuePipeline === false && job.payload.source === "bulk_prefetch"
        ),
        true,
      );
      assertEquals(await scheduleMissingPodcastDownloads(sql, podcastId, 4), {
        podcastId,
        eligibleCount: 2,
        queuedCount: 0,
        alreadyQueuedCount: 2,
      });

      await sql`
        UPDATE jobs SET status = 'completed', completed_at = now()
        WHERE type = 'DOWNLOAD_AUDIO' AND entity_id = ANY(${episodeIds}::uuid[])
      `;
      await sql`
        UPDATE episodes SET original_audio_path = '/data/prefetched.mp3',
          processing_status = 'downloaded'
        WHERE id IN (${firstEpisodeId}, ${failedEpisodeId})
      `;
      assertEquals(await scheduleMissingPodcastDownloads(sql, podcastId, 4), {
        podcastId,
        eligibleCount: 0,
        queuedCount: 0,
        alreadyQueuedCount: 0,
      });
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ANY(${episodeIds}::uuid[])`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
