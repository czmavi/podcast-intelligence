import type { Sql } from "../database/client.ts";
import { parsePodcastRss } from "./parser.ts";

const MAX_RSS_BYTES = 20_000_000;

async function fetchFeed(rssUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(rssUrl, {
      headers: { "user-agent": "PodcastIntelligence/0.1" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RSS server vrátil HTTP ${response.status}.`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RSS_BYTES) throw new Error("RSS feed je příliš velký.");
    const xml = await response.text();
    if (xml.length > MAX_RSS_BYTES) throw new Error("RSS feed je příliš velký.");
    return xml;
  } finally {
    clearTimeout(timer);
  }
}

export async function importPodcast(sql: Sql, rssUrl: string): Promise<{
  podcastId: string;
  importedEpisodes: number;
  newEpisodes: number;
  updatedEpisodes: number;
  restoredEpisodes: number;
  missingEpisodes: number;
}> {
  const parsed = await parsePodcastRss(await fetchFeed(rssUrl), rssUrl);
  return await sql.begin(async (tx) => {
    const podcastRows = await tx`
      INSERT INTO podcasts (name, rss_url, website_url, description, image_url, last_imported_at)
      VALUES (${parsed.name}, ${rssUrl}, ${parsed.websiteUrl}, ${parsed.description},
        ${parsed.imageUrl}, now())
      ON CONFLICT (rss_url) DO UPDATE
      SET name = EXCLUDED.name, website_url = EXCLUDED.website_url,
          description = EXCLUDED.description, image_url = EXCLUDED.image_url,
          last_imported_at = now(), updated_at = now()
      RETURNING id
    `;
    const podcastId = String(podcastRows[0]?.id);
    const existingRows = await tx`
      SELECT external_id, is_present_in_feed
      FROM episodes
      WHERE podcast_id = ${podcastId}
    `;
    const changes = calculateFeedChanges(
      existingRows.map((row) => ({
        externalId: String(row.externalId),
        isPresentInFeed: Boolean(row.isPresentInFeed),
      })),
      parsed.episodes.map((episode) => episode.externalId),
    );
    await tx`
      UPDATE episodes
      SET is_present_in_feed = false,
          missing_from_feed_since = COALESCE(missing_from_feed_since, now()),
          updated_at = now()
      WHERE podcast_id = ${podcastId}
    `;
    for (const episode of parsed.episodes) {
      await tx`
        INSERT INTO episodes (
          podcast_id, external_id, title, description, published_at, audio_url,
          source_url, duration_seconds, audio_mime_type, audio_byte_size,
          processing_status, is_present_in_feed, last_seen_in_feed_at
        ) VALUES (
          ${podcastId}, ${episode.externalId}, ${episode.title}, ${episode.description},
          ${episode.publishedAt}, ${episode.audioUrl}, ${episode.sourceUrl},
          ${episode.durationSeconds}, ${episode.audioMimeType}, ${episode.audioByteSize},
          'imported', true, now()
        )
        ON CONFLICT (podcast_id, external_id) DO UPDATE
        SET title = EXCLUDED.title, description = EXCLUDED.description,
            published_at = EXCLUDED.published_at, audio_url = EXCLUDED.audio_url,
            source_url = EXCLUDED.source_url,
            duration_seconds = COALESCE(EXCLUDED.duration_seconds, episodes.duration_seconds),
            audio_mime_type = COALESCE(EXCLUDED.audio_mime_type, episodes.audio_mime_type),
            audio_byte_size = COALESCE(EXCLUDED.audio_byte_size, episodes.audio_byte_size),
            is_present_in_feed = true, last_seen_in_feed_at = now(),
            missing_from_feed_since = NULL,
            updated_at = now()
      `;
    }
    return {
      podcastId,
      importedEpisodes: parsed.episodes.length,
      ...changes,
    };
  });
}

export function calculateFeedChanges(
  existing: Array<{ externalId: string; isPresentInFeed: boolean }>,
  incomingExternalIds: string[],
): {
  newEpisodes: number;
  updatedEpisodes: number;
  restoredEpisodes: number;
  missingEpisodes: number;
} {
  const existingById = new Map(existing.map((episode) => [episode.externalId, episode]));
  const incoming = new Set(incomingExternalIds);
  const newEpisodes = incomingExternalIds.filter((id) => !existingById.has(id)).length;
  const restoredEpisodes =
    incomingExternalIds.filter((id) =>
      existingById.has(id) && !existingById.get(id)?.isPresentInFeed
    ).length;
  return {
    newEpisodes,
    updatedEpisodes: incomingExternalIds.length - newEpisodes,
    restoredEpisodes,
    missingEpisodes: existing.filter((episode) => !incoming.has(episode.externalId)).length,
  };
}
