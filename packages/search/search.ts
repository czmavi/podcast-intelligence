import type { Sql } from "../database/client.ts";
import type { z } from "zod";
import type { searchSchema } from "../domain/schemas.ts";
import type { TextEmbeddingProvider } from "./providers.ts";
import { normalizedLexicalTerms } from "./query.ts";

type SearchInput = z.infer<typeof searchSchema>;

const czechDiacritics = "áčďéěíňóřšťúůýž";
const asciiEquivalents = "acdeeinorstuuyz";

interface SearchOptions {
  lexicalMatch?: "any" | "all";
}

const intentWords = new Set([
  "citace",
  "citaci",
  "citát",
  "citátu",
  "citáty",
  "hledej",
  "hledat",
  "najdi",
  "pasáž",
  "pasáže",
  "termín",
  "ukázka",
  "ukázku",
  "zmínka",
  "zmínku",
]);

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export function lexicalTerms(query: string): string[] {
  const all = query.toLocaleLowerCase("cs").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const meaningful = all.filter((word) => !intentWords.has(word));
  return meaningful.length > 0 ? meaningful : all;
}

export function rerankThreshold(
  precision: SearchInput["precision"],
  configuredMinimum: number,
): number {
  if (precision === "strict") return Math.max(0.5, configuredMinimum);
  if (precision === "related") return Math.min(0.05, configuredMinimum);
  return configuredMinimum;
}

function relevance(score: number, exact: boolean): "high" | "medium" | "low" {
  if (exact) return "high";
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

export function passesRerank(
  precision: SearchInput["precision"],
  reranker: number | null,
  exact: number,
  configuredMinimum: number,
): boolean {
  if (reranker === null || exact > 0) return true;
  return reranker >= rerankThreshold(precision, configuredMinimum);
}

export async function search(
  sql: Sql,
  input: SearchInput,
  provider: TextEmbeddingProvider,
  options: SearchOptions = {},
) {
  const terms = lexicalTerms(input.query);
  const lexicalQuery = terms.map((term) => `"${term}"`).join(" OR ");
  const exactPhrase = terms.join(" ");
  const requireAllTerms = options.lexicalMatch === "all";
  const normalizedTerms = normalizedLexicalTerms(input.query);
  const normalizedQuery = normalizedTerms.map((term) => `${term}:*`).join(" & ");
  let queryEmbedding: string | null = null;
  if (input.mode !== "fulltext") {
    queryEmbedding = vectorLiteral(await provider.embedQuery(input.query));
  }
  const candidateLimit = Math.max(input.limit, provider.candidateLimit);
  const rows = await sql`
    WITH ranked AS (
      SELECT
        chunk.id AS chunk_id,
        episode.id AS episode_id,
        episode.title AS episode_title,
        episode.published_at,
        COALESCE(chunk.playback_start_seconds, chunk.start_seconds) AS start_seconds,
        chunk.end_seconds,
        CASE WHEN ${requireAllTerms} AND ${input.personId ?? null}::uuid IS NOT NULL
          THEN speaker_excerpt.text
          ELSE chunk.text
        END AS text,
        ts_rank_cd(
          CASE WHEN ${requireAllTerms}
            THEN CASE WHEN ${input.personId ?? null}::uuid IS NULL
              THEN chunk.normalized_search_vector
              ELSE to_tsvector(
                'simple',
                translate(
                  lower(coalesce(speaker_excerpt.text, '')),
                  ${czechDiacritics},
                  ${asciiEquivalents}
                )
              )
            END
            ELSE chunk.search_vector
          END,
          CASE WHEN ${requireAllTerms}
            THEN to_tsquery('simple', ${normalizedQuery})
            ELSE websearch_to_tsquery('simple', ${lexicalQuery})
          END
        )::float8 AS fulltext_score,
        CASE
          WHEN ${requireAllTerms} AND (
            CASE WHEN ${input.personId ?? null}::uuid IS NULL
              THEN chunk.normalized_search_vector
              ELSE to_tsvector(
                'simple',
                translate(
                  lower(coalesce(speaker_excerpt.text, '')),
                  ${czechDiacritics},
                  ${asciiEquivalents}
                )
              )
            END
          ) @@ to_tsquery('simple', ${normalizedQuery}) THEN 1::float8
          WHEN NOT ${requireAllTerms} AND position(lower(${exactPhrase}) in lower(chunk.text)) > 0
            THEN 1::float8
          ELSE 0::float8
        END AS exact_score,
        CASE
          WHEN ${queryEmbedding}::text IS NULL OR chunk.embedding IS NULL
            OR chunk.embedding_model <> ${provider.modelName}
          THEN 0::float8
          ELSE (1 - (chunk.embedding <=> ${queryEmbedding}::vector))::float8
        END AS semantic_score
      FROM content_chunks chunk
      JOIN episodes episode ON episode.id = chunk.episode_id
      LEFT JOIN LATERAL (
        SELECT string_agg(utterance.text, E'\n' ORDER BY link.position) AS text
        FROM content_chunk_utterances link
        JOIN utterances utterance ON utterance.id = link.utterance_id
        WHERE link.content_chunk_id = chunk.id
          AND utterance.person_id = ${input.personId ?? null}::uuid
      ) speaker_excerpt ON ${input.personId ?? null}::uuid IS NOT NULL
      WHERE episode.active_processing_run_id = chunk.processing_run_id
        AND NOT episode.rag_excluded
        AND (${input.personId ?? null}::uuid IS NULL OR speaker_excerpt.text IS NOT NULL)
        AND (${input.podcastId ?? null}::uuid IS NULL
          OR episode.podcast_id = ${input.podcastId ?? null}::uuid)
        AND (${input.episodeId ?? null}::uuid IS NULL
          OR episode.id = ${input.episodeId ?? null}::uuid)
        AND (${input.dateFrom ?? null}::date IS NULL
          OR episode.published_at >= ${input.dateFrom ?? null}::date)
        AND (${input.dateTo ?? null}::date IS NULL
          OR episode.published_at < (${input.dateTo ?? null}::date + interval '1 day'))
    ), candidates AS (
      SELECT ranked.*,
        CASE ${input.mode}
          WHEN 'fulltext' THEN (fulltext_score + exact_score)
          WHEN 'semantic' THEN semantic_score
          ELSE (exact_score + LEAST(1, fulltext_score * 4) + GREATEST(0, semantic_score))
        END::float8 AS retrieval_score
      FROM ranked
      WHERE (${input.mode} = 'semantic' AND semantic_score > 0)
         OR (${input.mode} = 'fulltext' AND fulltext_score > 0)
         OR (${input.mode} = 'hybrid' AND (fulltext_score > 0 OR semantic_score > 0))
      ORDER BY retrieval_score DESC, published_at DESC NULLS LAST
      LIMIT ${candidateLimit}
    )
    SELECT candidates.*,
      COALESCE((
        SELECT jsonb_agg(DISTINCT jsonb_build_object(
          'id', person.id, 'displayName', person.display_name
        ))
        FROM content_chunk_utterances link
        JOIN utterances utterance ON utterance.id = link.utterance_id
        JOIN persons person ON person.id = utterance.person_id
        WHERE link.content_chunk_id = candidates.chunk_id
          AND (${input.personId ?? null}::uuid IS NULL
            OR person.id = ${input.personId ?? null}::uuid)
      ), '[]'::jsonb) AS persons
    FROM candidates
    ORDER BY retrieval_score DESC, published_at DESC NULLS LAST
  `;

  const rerankerScores = input.mode === "fulltext" || rows.length === 0
    ? rows.map(() => null)
    : await provider.rerank(input.query, rows.map((row) => String(row.text)));
  return rows.map((row, index) => {
    const reranker = rerankerScores[index] ?? null;
    const semantic = Number(row.semanticScore);
    const fulltext = Number(row.fulltextScore);
    const exact = Number(row.exactScore);
    const combined = reranker === null
      ? Number(row.retrievalScore)
      : 0.8 * reranker + 0.15 * Math.max(0, semantic) + 0.05 * Math.max(exact, fulltext);
    return {
      chunkId: row.chunkId,
      episodeId: row.episodeId,
      episodeTitle: row.episodeTitle,
      publishedAt: row.publishedAt,
      startSeconds: Number(row.startSeconds),
      endSeconds: Number(row.endSeconds),
      text: row.text,
      persons: row.persons,
      relevance: relevance(reranker ?? Math.min(1, combined), exact > 0),
      scores: { fulltext, semantic, reranker, exact, combined },
    };
  }).filter((result) =>
    passesRerank(
      input.precision,
      result.scores.reranker,
      result.scores.exact,
      provider.minRerankScore,
    )
  )
    .sort((left, right) => right.scores.combined - left.scores.combined)
    .slice(0, input.limit);
}
