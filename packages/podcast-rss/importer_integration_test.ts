import { assertEquals } from "@std/assert";
import { createDatabase } from "../database/client.ts";
import { importPodcast } from "./importer.ts";

const runIntegration = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

function feed(items: Array<{ id: string; title: string }>, imageUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Refresh integration</title>
    <link>https://example.test</link><description>Test</description>
    <image><url>${imageUrl}</url></image>
    ${
    items.map((item) =>
      `<item><guid>${item.id}</guid><title>${item.title}</title>
      <enclosure url="https://example.test/${item.id}.mp3" type="audio/mpeg" /></item>`
    ).join("")
  }</channel></rss>`;
}

Deno.test({
  name: "integration: RSS refresh zachová epizodu, která zmizela z feedu",
  ignore: !runIntegration,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let currentFeed = feed(
      [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      "https://example.test/cover-before.jpg",
    );
    let port = 0;
    let server: ReturnType<typeof Deno.serve> | undefined;
    const listening = new Promise<void>((resolve) => {
      server = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen(address) {
          port = address.port;
          resolve();
        },
      }, () => new Response(currentFeed, { headers: { "content-type": "application/rss+xml" } }));
    });
    await listening;
    const rssUrl = `http://127.0.0.1:${port}/feed.xml`;
    const sql = createDatabase({
      DATABASE_URL: Deno.env.get("DATABASE_URL") ??
        "postgres://podcast:podcast@localhost:55432/podcast",
    });
    let podcastId: string | undefined;
    try {
      const first = await importPodcast(sql, rssUrl);
      podcastId = first.podcastId;
      assertEquals(first.newEpisodes, 2);
      currentFeed = feed(
        [{ id: "b", title: "B updated" }, { id: "c", title: "C" }],
        "https://example.test/cover-after.jpg",
      );
      const second = await importPodcast(sql, rssUrl);
      assertEquals(second.missingEpisodes, 1);
      assertEquals(second.newEpisodes, 1);
      const podcast = await sql`SELECT image_url FROM podcasts WHERE id = ${first.podcastId}`;
      assertEquals(podcast[0]?.imageUrl, "https://example.test/cover-after.jpg");
      const episodes = await sql`
        SELECT external_id, title, is_present_in_feed
        FROM episodes WHERE podcast_id = ${first.podcastId}
        ORDER BY external_id
      `;
      assertEquals(
        episodes.map((episode) => ({
          externalId: episode.externalId,
          title: episode.title,
          isPresentInFeed: episode.isPresentInFeed,
        })),
        [
          { externalId: "a", title: "A", isPresentInFeed: false },
          { externalId: "b", title: "B updated", isPresentInFeed: true },
          { externalId: "c", title: "C", isPresentInFeed: true },
        ],
      );
    } finally {
      if (podcastId) await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
      await server?.shutdown();
    }
  },
});
