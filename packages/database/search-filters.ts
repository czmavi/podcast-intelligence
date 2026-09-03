import { NotFoundError } from "../domain/errors.ts";
import type { Sql } from "./client.ts";

export interface SearchFilterOption {
  id: string;
  label: string;
}

export async function searchFilterOptions(
  sql: Sql,
  podcastId: string,
  episodeId?: string,
): Promise<{ episodes: SearchFilterOption[]; people: SearchFilterOption[] }> {
  const podcast = await sql`SELECT id FROM podcasts WHERE id = ${podcastId}`;
  if (!podcast[0]) throw new NotFoundError("Podcast");

  const episodes = await sql`
    SELECT episode.id, episode.title AS label
    FROM episodes episode
    WHERE episode.podcast_id = ${podcastId}
      AND NOT episode.rag_excluded
      AND EXISTS (
        SELECT 1 FROM content_chunks chunk
        WHERE chunk.episode_id = episode.id
          AND chunk.processing_run_id = episode.active_processing_run_id
      )
    ORDER BY episode.published_at DESC NULLS LAST, episode.created_at DESC
  `;
  if (episodeId && !episodes.some((episode) => String(episode.id) === episodeId)) {
    throw new NotFoundError("Prohledatelná epizoda");
  }

  const people = await sql`
    SELECT DISTINCT person.id, person.display_name AS label
    FROM persons person
    JOIN utterances utterance ON utterance.person_id = person.id
    JOIN episodes episode
      ON episode.id = utterance.episode_id
      AND episode.active_processing_run_id = utterance.processing_run_id
    WHERE episode.podcast_id = ${podcastId}
      AND NOT episode.rag_excluded
      AND (${episodeId ?? null}::uuid IS NULL OR episode.id = ${episodeId ?? null}::uuid)
      AND EXISTS (
        SELECT 1 FROM content_chunks chunk
        WHERE chunk.episode_id = episode.id
          AND chunk.processing_run_id = episode.active_processing_run_id
      )
    ORDER BY label
  `;
  return {
    episodes: episodes.map((episode) => ({
      id: String(episode.id),
      label: String(episode.label),
    })),
    people: people.map((person) => ({
      id: String(person.id),
      label: String(person.label),
    })),
  };
}
