import type { Sql } from "../../../packages/database/client.ts";

export interface ChunkUtterance {
  id: string;
  startSeconds: number;
  endSeconds: number;
  playbackStartSeconds: number | null;
  text: string;
  personId: string | null;
  speakerClusterId: string;
  overlapDetected: boolean;
}

export interface ContentChunk {
  startSeconds: number;
  endSeconds: number;
  playbackStartSeconds: number;
  text: string;
  tokenCount: number;
  utteranceIds: string[];
  personIds: string[];
}

export interface ChunkOptions {
  targetWords?: number;
  maxWords?: number;
  overlapUtterances?: number;
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

export function createContentChunks(
  utterances: ChunkUtterance[],
  options: ChunkOptions = {},
): ContentChunk[] {
  const target = options.targetWords ?? 140;
  const maximum = options.maxWords ?? 220;
  const overlap = options.overlapUtterances ?? 1;
  const valid = utterances.filter((utterance) =>
    utterance.text.trim() && utterance.endSeconds > utterance.startSeconds
  );
  if (valid.length === 0) return [];

  const chunks: ContentChunk[] = [];
  let start = 0;
  while (start < valid.length) {
    let end = start;
    let wordCount = 0;
    while (end < valid.length) {
      const current = valid[end]!;
      const nextWords = words(current.text);
      if (end > start && wordCount + nextWords > maximum) break;
      wordCount += nextWords;
      end += 1;
      if (wordCount >= target) {
        const next = valid[end];
        const previous = valid[end - 1];
        if (!next || !previous || next.speakerClusterId !== previous.speakerClusterId) break;
      }
    }
    if (end === start) end += 1;
    const selected = valid.slice(start, end);
    const people = new Set(
      selected.flatMap((utterance) => utterance.personId ? [utterance.personId] : []),
    );
    chunks.push({
      startSeconds: selected[0]!.startSeconds,
      endSeconds: selected[selected.length - 1]!.endSeconds,
      playbackStartSeconds: Math.min(
        ...selected.map((utterance) => utterance.playbackStartSeconds ?? utterance.startSeconds),
      ),
      text: selected.map((utterance) => utterance.text.trim()).join("\n"),
      tokenCount: Math.ceil(wordCount * 1.35),
      utteranceIds: selected.map((utterance) => utterance.id),
      personIds: [...people],
    });
    if (end >= valid.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export async function createAndPersistChunks(sql: Sql, episodeId: string): Promise<number> {
  return await sql.begin(async (tx) => {
    const runRows = await tx`
      SELECT active_processing_run_id AS run_id
      FROM episodes WHERE id = ${episodeId} FOR UPDATE
    `;
    const runId = runRows[0]?.runId as string | undefined;
    if (!runId) throw new Error("Epizoda nemá aktivní processing run.");
    const rows = await tx`
      SELECT id, start_seconds, end_seconds, text, person_id, speaker_cluster_id,
        overlap_detected, playback_start_seconds
      FROM utterances
      WHERE episode_id = ${episodeId} AND processing_run_id = ${runId}
      ORDER BY sequence_number
    `;
    const chunks = createContentChunks(rows as unknown as ChunkUtterance[]);
    await tx`DELETE FROM content_chunks WHERE processing_run_id = ${runId}`;
    for (const chunk of chunks) {
      const inserted = await tx`
        INSERT INTO content_chunks (
          episode_id, processing_run_id, start_seconds, end_seconds, playback_start_seconds,
          text, token_count
        ) VALUES (
          ${episodeId}, ${runId}, ${chunk.startSeconds}, ${chunk.endSeconds},
          ${chunk.playbackStartSeconds}, ${chunk.text}, ${chunk.tokenCount}
        ) RETURNING id
      `;
      const chunkId = String(inserted[0]?.id);
      for (const [position, utteranceId] of chunk.utteranceIds.entries()) {
        await tx`
          INSERT INTO content_chunk_utterances (content_chunk_id, utterance_id, position)
          VALUES (${chunkId}, ${utteranceId}, ${position})
        `;
      }
    }
    await tx`
      UPDATE episodes
      SET processing_status = 'indexing', processing_error = NULL, updated_at = now()
      WHERE id = ${episodeId}
    `;
    return chunks.length;
  });
}
