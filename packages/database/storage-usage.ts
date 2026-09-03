import { join } from "@std/path";
import type { Sql } from "./client.ts";
import { episodeStorage } from "../shared/paths.ts";

export interface StorageUsageBreakdown {
  totalBytes: number;
  audioBytes: number;
  transcriptBytes: number;
  otherBytes: number;
}

async function directoryByteSize(path: string): Promise<number> {
  let total = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory) {
        total += await directoryByteSize(entryPath);
      } else if (entry.isFile) {
        total += (await Deno.stat(entryPath)).size;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  return total;
}

async function derivedStorageBreakdown(path: string): Promise<{
  transcriptBytes: number;
  otherBytes: number;
}> {
  let transcriptBytes = 0;
  let otherBytes = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory) {
        const nested = await derivedStorageBreakdown(entryPath);
        transcriptBytes += nested.transcriptBytes;
        otherBytes += nested.otherBytes;
      } else if (entry.isFile) {
        const size = (await Deno.stat(entryPath)).size;
        if (entry.name.startsWith("transcript-") && entry.name.endsWith(".json")) {
          transcriptBytes += size;
        } else {
          otherBytes += size;
        }
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { transcriptBytes: 0, otherBytes: 0 };
    throw error;
  }
  return { transcriptBytes, otherBytes };
}

async function unknownEpisodeStorageBytes(path: string): Promise<number> {
  let bytes = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      if (["original", "normalized", "derived"].includes(entry.name)) continue;
      const entryPath = join(path, entry.name);
      if (entry.isDirectory) bytes += await directoryByteSize(entryPath);
      else if (entry.isFile) bytes += (await Deno.stat(entryPath)).size;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  return bytes;
}

async function episodeStorageBreakdown(
  storageRoot: string,
  podcastId: string,
  episodeId: string,
): Promise<StorageUsageBreakdown> {
  const paths = episodeStorage(storageRoot, podcastId, episodeId);
  const [originalBytes, normalizedBytes, derived, unknownBytes] = await Promise.all([
    directoryByteSize(paths.original),
    directoryByteSize(paths.normalized),
    derivedStorageBreakdown(paths.derived),
    unknownEpisodeStorageBytes(paths.base),
  ]);
  const otherBytes = derived.otherBytes + unknownBytes;
  return {
    totalBytes: originalBytes + normalizedBytes + derived.transcriptBytes + otherBytes,
    audioBytes: originalBytes + normalizedBytes,
    transcriptBytes: derived.transcriptBytes,
    otherBytes,
  };
}

export async function refreshEpisodeStorageUsage(
  sql: Sql,
  storageRoot: string,
  episodeId: string,
): Promise<{ episode: StorageUsageBreakdown; podcast: StorageUsageBreakdown } | null> {
  return await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT episode.id, episode.podcast_id
      FROM episodes episode
      JOIN podcasts podcast ON podcast.id = episode.podcast_id
      WHERE episode.id = ${episodeId}
      FOR UPDATE OF podcast
    `;
    const episode = rows[0];
    if (!episode) return null;

    const usage = await episodeStorageBreakdown(
      storageRoot,
      String(episode.podcastId),
      episodeId,
    );
    await tx`
      UPDATE episodes SET storage_byte_size = ${usage.totalBytes},
        storage_audio_byte_size = ${usage.audioBytes},
        storage_transcript_byte_size = ${usage.transcriptBytes},
        storage_other_byte_size = ${usage.otherBytes}, updated_at = now()
      WHERE id = ${episodeId}
    `;
    const totals = await tx`
      SELECT COALESCE(sum(storage_byte_size), 0)::bigint AS total_bytes,
        COALESCE(sum(storage_audio_byte_size), 0)::bigint AS audio_bytes,
        COALESCE(sum(storage_transcript_byte_size), 0)::bigint AS transcript_bytes,
        COALESCE(sum(storage_other_byte_size), 0)::bigint AS other_bytes
      FROM episodes WHERE podcast_id = ${episode.podcastId}
    `;
    const podcast = {
      totalBytes: Number(totals[0]?.totalBytes ?? 0),
      audioBytes: Number(totals[0]?.audioBytes ?? 0),
      transcriptBytes: Number(totals[0]?.transcriptBytes ?? 0),
      otherBytes: Number(totals[0]?.otherBytes ?? 0),
    };
    await tx`
      UPDATE podcasts SET storage_byte_size = ${podcast.totalBytes},
        storage_audio_byte_size = ${podcast.audioBytes},
        storage_transcript_byte_size = ${podcast.transcriptBytes},
        storage_other_byte_size = ${podcast.otherBytes}, updated_at = now()
      WHERE id = ${episode.podcastId}
    `;
    return { episode: usage, podcast };
  });
}

export async function refreshPodcastStorageUsage(
  sql: Sql,
  storageRoot: string,
  podcastId: string,
): Promise<{ episodes: number; usage: StorageUsageBreakdown } | null> {
  return await sql.begin(async (tx) => {
    const podcasts = await tx`
      SELECT id FROM podcasts WHERE id = ${podcastId} FOR UPDATE
    `;
    if (!podcasts[0]) return null;
    const episodes = await tx`
      SELECT id FROM episodes WHERE podcast_id = ${podcastId} ORDER BY created_at
    `;
    const usage: StorageUsageBreakdown = {
      totalBytes: 0,
      audioBytes: 0,
      transcriptBytes: 0,
      otherBytes: 0,
    };
    for (const episode of episodes) {
      const episodeId = String(episode.id);
      const episodeUsage = await episodeStorageBreakdown(storageRoot, podcastId, episodeId);
      usage.totalBytes += episodeUsage.totalBytes;
      usage.audioBytes += episodeUsage.audioBytes;
      usage.transcriptBytes += episodeUsage.transcriptBytes;
      usage.otherBytes += episodeUsage.otherBytes;
      await tx`
        UPDATE episodes SET storage_byte_size = ${episodeUsage.totalBytes},
          storage_audio_byte_size = ${episodeUsage.audioBytes},
          storage_transcript_byte_size = ${episodeUsage.transcriptBytes},
          storage_other_byte_size = ${episodeUsage.otherBytes}
        WHERE id = ${episodeId}
      `;
    }
    await tx`
      UPDATE podcasts SET storage_byte_size = ${usage.totalBytes},
        storage_audio_byte_size = ${usage.audioBytes},
        storage_transcript_byte_size = ${usage.transcriptBytes},
        storage_other_byte_size = ${usage.otherBytes}, updated_at = now()
      WHERE id = ${podcastId}
    `;
    return { episodes: episodes.length, usage };
  });
}
