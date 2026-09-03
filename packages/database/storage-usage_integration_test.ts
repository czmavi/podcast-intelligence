import { assertEquals } from "@std/assert";
import { createDatabase } from "./client.ts";
import { refreshEpisodeStorageUsage } from "./storage-usage.ts";
import { loadConfig } from "../shared/config.ts";
import { episodeStorage } from "../shared/paths.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: velikost podcastu sečte audio, přepis a ostatní soubory",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const storageRoot = await Deno.makeTempDir({ prefix: "podcast-storage-usage-" });
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Storage test', ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO episodes (id, podcast_id, external_id, title, audio_url, processing_status)
        VALUES (${episodeId}, ${podcastId}, 'storage', 'Storage',
          'https://example.test/audio.mp3', 'imported')
      `;
      const paths = episodeStorage(storageRoot, podcastId, episodeId);
      await Promise.all([
        Deno.mkdir(paths.original, { recursive: true }),
        Deno.mkdir(paths.normalized, { recursive: true }),
        Deno.mkdir(paths.derived, { recursive: true }),
      ]);
      await Promise.all([
        Deno.writeFile(`${paths.original}/audio.mp3`, new Uint8Array(10)),
        Deno.writeFile(`${paths.normalized}/audio.wav`, new Uint8Array(20)),
        Deno.writeFile(`${paths.derived}/transcript-test.json`, new Uint8Array(30)),
        Deno.writeFile(`${paths.derived}/other.bin`, new Uint8Array(40)),
      ]);

      const usage = await refreshEpisodeStorageUsage(sql, storageRoot, episodeId);
      assertEquals(usage?.episode, {
        totalBytes: 100,
        audioBytes: 30,
        transcriptBytes: 30,
        otherBytes: 40,
      });
      assertEquals(usage?.podcast, usage?.episode);
      const rows = await sql`
        SELECT storage_byte_size, storage_audio_byte_size,
          storage_transcript_byte_size, storage_other_byte_size
        FROM podcasts WHERE id = ${podcastId}
      `;
      assertEquals(Number(rows[0]?.storageByteSize), 100);
      assertEquals(Number(rows[0]?.storageAudioByteSize), 30);
      assertEquals(Number(rows[0]?.storageTranscriptByteSize), 30);
      assertEquals(Number(rows[0]?.storageOtherByteSize), 40);
    } finally {
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
      await Deno.remove(storageRoot, { recursive: true });
    }
  },
});
