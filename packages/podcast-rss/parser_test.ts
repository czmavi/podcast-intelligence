import { assertEquals, assertMatch } from "@std/assert";
import { parsePodcastRss } from "./parser.ts";

Deno.test("RSS parser načte namespace, HTML, relativní URL a odstraní duplicity", async () => {
  const xml = await Deno.readTextFile(
    new URL("./fixtures/basic.xml", import.meta.url),
  );
  const podcast = await parsePodcastRss(xml, "https://example.test/feed.xml");
  assertEquals(podcast.name, "Testovací podcast");
  assertEquals(podcast.episodes.length, 2);
  assertEquals(podcast.episodes[0]?.durationSeconds, 3723);
  assertEquals(podcast.episodes[0]?.description, "Hostem je Jana.");
  assertEquals(podcast.imageUrl, "https://example.test/cover.jpg");
  assertEquals(podcast.episodes[1]?.audioUrl, "https://example.test/audio/two.mp3");
  assertMatch(podcast.episodes[1]?.externalId ?? "", /^sha256:[a-f0-9]{64}$/);
});

Deno.test("RSS parser použije i standardní channel image", async () => {
  const podcast = await parsePodcastRss(
    `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Standardní obrázek</title><link>https://example.test/show</link>
      <description>Popis</description><image><url>/cover.png</url></image>
      <item><guid>one</guid><title>Díl</title>
      <enclosure url="https://example.test/one.mp3" type="audio/mpeg"/></item>
    </channel></rss>`,
    "https://example.test/feed.xml",
  );
  assertEquals(podcast.imageUrl, "https://example.test/cover.png");
});
