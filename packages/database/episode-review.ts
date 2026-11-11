import { NotFoundError } from "../domain/errors.ts";
import type { Sql } from "./client.ts";

export async function nextSpeakerReviewEpisode(
  sql: Sql,
  podcastId: string,
  currentEpisodeId: string,
): Promise<string | null> {
  const [episode] = await sql<{ id: string }[]>`
    SELECT candidate.id FROM episodes candidate
    WHERE candidate.podcast_id = ${podcastId} AND candidate.id <> ${currentEpisodeId}
      AND NOT candidate.rag_excluded AND NOT candidate.speaker_review_skipped
      AND (candidate.transcript_selection_pending OR EXISTS (
        SELECT 1 FROM speaker_clusters cluster
        WHERE cluster.episode_id = candidate.id
          AND cluster.processing_run_id = candidate.active_processing_run_id
          AND cluster.identity_status NOT IN ('verified', 'ignored')
      ))
    ORDER BY candidate.published_at DESC NULLS LAST, candidate.created_at DESC, candidate.id DESC
    LIMIT 1
  `;
  return episode?.id ?? null;
}

export async function setEpisodeSpeakerReviewSkipped(
  sql: Sql,
  episodeId: string,
  skipped: boolean,
) {
  const [episode] = await sql<{ id: string }[]>`
    UPDATE episodes SET speaker_review_skipped = ${skipped}, updated_at = now()
    WHERE id = ${episodeId} RETURNING id
  `;
  if (!episode) throw new NotFoundError("Epizoda");
  return { episodeId: episode.id, skipped };
}
