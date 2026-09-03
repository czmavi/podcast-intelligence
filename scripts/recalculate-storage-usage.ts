import { createDatabase } from "../packages/database/client.ts";
import { refreshPodcastStorageUsage } from "../packages/database/storage-usage.ts";
import { loadConfig } from "../packages/shared/config.ts";

const config = loadConfig();
const sql = createDatabase(config);

try {
  const podcasts = await sql`SELECT id, name FROM podcasts ORDER BY created_at`;
  for (const podcast of podcasts) {
    const result = await refreshPodcastStorageUsage(
      sql,
      config.STORAGE_ROOT,
      String(podcast.id),
    );
    console.log(JSON.stringify({
      podcastId: String(podcast.id),
      podcastName: String(podcast.name),
      episodes: result?.episodes ?? 0,
      storage: result?.usage ?? null,
    }));
  }
} finally {
  await sql.end({ timeout: 10 });
}
