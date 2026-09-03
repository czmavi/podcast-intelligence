import { assertEquals } from "@std/assert";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { scheduleDuePodcastRefresh } from "./podcast-refresh.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: denní RSS automatika zařadí nejvýše jeden idempotentní refresh",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    try {
      await sql`
        INSERT INTO podcasts (
          id, name, rss_url, auto_refresh_enabled, last_imported_at
        ) VALUES (
          ${podcastId}, 'Denní RSS test', ${`https://example.test/${podcastId}.xml`}, true,
          now() - interval '2 days'
        )
      `;
      const attempts = await Promise.all([
        scheduleDuePodcastRefresh(sql, 3),
        scheduleDuePodcastRefresh(sql, 3),
      ]);
      const scheduled = attempts.filter((item) => item !== null);
      assertEquals(scheduled.length, 1);
      assertEquals(scheduled[0]?.podcastId, podcastId);
      assertEquals(await scheduleDuePodcastRefresh(sql, 3), null);
      const jobs = await sql`
        SELECT type, entity_type, payload->>'source' AS source
        FROM jobs WHERE entity_id = ${podcastId}
      `;
      assertEquals(
        jobs.map((job) => ({
          type: String(job.type),
          entityType: String(job.entityType),
          source: String(job.source),
        })),
        [{
          type: "IMPORT_FEED",
          entityType: "podcast",
          source: "daily_auto_refresh",
        }],
      );
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ${podcastId}`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
