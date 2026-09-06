import { join } from "@std/path";
import { DomainError, NotFoundError } from "../domain/errors.ts";
import { episodeStorage } from "../shared/paths.ts";
import type { Sql } from "./client.ts";
import { refreshEpisodeStorageUsage } from "./storage-usage.ts";

async function removeTranscriptFiles(path: string): Promise<number> {
  let removed = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory) {
        removed += await removeTranscriptFiles(entryPath);
      } else if (
        entry.isFile && entry.name.startsWith("transcript-") && entry.name.endsWith(".json")
      ) {
        await Deno.remove(entryPath);
        removed += 1;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return removed;
    throw error;
  }
  return removed;
}

export async function updateEpisodeRagExclusion(
  sql: Sql,
  storageRoot: string,
  episodeId: string,
  excluded: boolean,
): Promise<{ id: string; ragExcluded: boolean; deletedTranscriptFiles: number }> {
  const episode = await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT id, podcast_id FROM episodes WHERE id = ${episodeId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundError("Epizoda");

    if (excluded) {
      const activeJobs = await tx`
        SELECT 1 FROM jobs
        WHERE entity_type = 'episode' AND entity_id = ${episodeId}
          AND status IN ('queued', 'running')
        LIMIT 1
      `;
      if (activeJobs.length > 0) {
        throw new DomainError(
          "Epizodu nelze vyloučit během zpracování. Počkejte na dokončení aktivní úlohy.",
          "EPISODE_PROCESSING_ACTIVE",
          409,
        );
      }
      await tx`
        UPDATE episodes SET rag_excluded = true, processing_error = NULL,
          transcript_selection_pending = false, updated_at = now()
        WHERE id = ${episodeId}
      `;
      await tx`DELETE FROM claims WHERE episode_id = ${episodeId}`;
      await tx`
        DELETE FROM processing_artifacts
        WHERE episode_id = ${episodeId} AND artifact_type = 'transcript_json'
      `;
      await tx`DELETE FROM processing_runs WHERE episode_id = ${episodeId}`;
    } else {
      await tx`
        UPDATE episodes SET rag_excluded = false, updated_at = now() WHERE id = ${episodeId}
      `;
    }
    return { id: String(row.id), podcastId: String(row.podcastId) };
  });

  let deletedTranscriptFiles = 0;
  if (excluded) {
    const paths = episodeStorage(storageRoot, episode.podcastId, episode.id);
    deletedTranscriptFiles = await removeTranscriptFiles(paths.derived);
    await refreshEpisodeStorageUsage(sql, storageRoot, episode.id);
  }
  return { id: episode.id, ragExcluded: excluded, deletedTranscriptFiles };
}
