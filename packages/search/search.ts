import type { Sql } from "../database/client.ts";
import type { z } from "zod";
import type { searchSchema } from "../domain/schemas.ts";
import type { TextEmbeddingProvider } from "./providers.ts";
import { comparisonSearchQueries, normalizedTsQuery } from "./query.ts";
import { selectDiverseExcerpts } from "./excerpts.ts";
import { type NameQuery, nameQuery } from "./names.ts";

import type { SearchPlan } from "./plan.ts";

type SearchInput = z.infer<typeof searchSchema>;

const czechDiacritics = "áčďéěíňóřšťúůýž";
const asciiEquivalents = "acdeeinorstuuyz";

interface SearchOptions {
  lexicalMatch?: "any" | "all";
  /** Přehled napříč archivem: vyvážit epizody ještě před omezením kandidátů. */
  diversifyEpisodes?: boolean;
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
  const comparison = options.lexicalMatch === "all" ? comparisonSearchQueries(input.query) : null;
  const knownPeople = options.lexicalMatch === "all" && input.mode === "fulltext"
    ? (await sql<{ displayName: string }[]>`SELECT display_name FROM persons`).map((p) =>
      p.displayName
    )
    : [];
  if (comparison) {
    // Každá strana dostane vlastní kandidátní rozpočet i všechny původní filtry.
    // Sekvenčně, abychom nezvyšovali špičkovou zátěž databáze.
    const groups: Awaited<ReturnType<typeof searchSingle>>[] = [];
    for (const query of comparison) {
      groups.push(await searchSingle(sql, { ...input, query }, provider, options, knownPeople));
    }
    const interleaved = Array.from(
      { length: input.limit },
      (_, index) => groups.flatMap((group) => group[index] ? [group[index]!] : []),
    ).flat();
    return selectDiverseExcerpts(interleaved, input.limit, input.episodeId ? input.limit : 2);
  }
  return searchSingle(sql, input, provider, options, knownPeople);
}

interface NameContext {
  plan: NameQuery;
  expand: boolean;
  ambiguous: boolean;
  unambiguousEpisodes: string[];
}

async function resolveName(
  sql: Sql,
  input: SearchInput,
  knownPeople: string[],
): Promise<NameContext | null> {
  const plan = nameQuery(input.query, knownPeople);
  if (!plan) return null;
  // Kontext identity může dodat jiný mluvčí, vlastní výsledky ale stále filtrujeme
  // podle požadované osoby. Čteme jen aktivní přepisy a stejný rozsah jako dotaz.
  const mentions = await sql<{ episodeId: string; givenName: string }[]>`
    SELECT DISTINCT episode.id AS episode_id, mention.parts[1] AS given_name
    FROM content_chunks chunk
    JOIN episodes episode ON episode.id = chunk.episode_id
    CROSS JOIN LATERAL regexp_matches(
      translate(lower(chunk.text), ${czechDiacritics}, ${asciiEquivalents}),
      ${plan.mentionsPattern}, 'g'
    ) AS mention(parts)
    WHERE chunk.normalized_search_vector @@ to_tsquery('simple', ${plan.surnameQuery})
      AND episode.active_processing_run_id = chunk.processing_run_id
      AND NOT episode.rag_excluded
      AND (${input.podcastId ?? null}::uuid IS NULL OR episode.podcast_id = ${
    input.podcastId ?? null
  }::uuid)
      AND (${input.episodeId ?? null}::uuid IS NULL OR episode.id = ${
    input.episodeId ?? null
  }::uuid)
      AND (${input.dateFrom ?? null}::date IS NULL OR episode.published_at >= ${
    input.dateFrom ?? null
  }::date)
      AND (${input.dateTo ?? null}::date IS NULL OR episode.published_at < (${
    input.dateTo ?? null
  }::date + interval '1 day'))
  `;
  const identities = new Set<string>();
  const episodes = new Map<string, Set<string>>();
  for (const mention of mentions) {
    const given = plan.givenForms.includes(mention.givenName)
      ? plan.given
      : plan.canonicalGiven.get(mention.givenName);
    if (!given) continue;
    identities.add(given);
    const names = episodes.get(mention.episodeId) ?? new Set<string>();
    names.add(given);
    episodes.set(mention.episodeId, names);
  }
  return {
    plan,
    expand: identities.has(plan.given),
    ambiguous: identities.size > 1,
    unambiguousEpisodes: [...episodes].filter(([, names]) =>
      names.size === 1 && names.has(plan.given)
    ).map(([id]) => id),
  };
}

// Split a union into independent, bounded candidate pools. For conjunctions the
// extra predicates run on the same speaker excerpt before SQL ranking and LIMIT.
export async function searchWithPlan(
  sql: Sql,
  input: SearchInput,
  provider: TextEmbeddingProvider,
  plan: SearchPlan,
) {
  const people = (await sql<{ displayName: string }[]>`SELECT display_name FROM persons`).map((p) =>
    p.displayName
  );
  const any = "any" in plan.match;
  const clauses = "any" in plan.match ? plan.match.any : plan.match.all;
  const prepared = [];
  for (const clause of clauses) {
    const query = "topic" in clause ? clause.topic : clause.personMention;
    const name = "personMention" in clause
      ? await resolveName(sql, { ...input, query }, people)
      : null;
    prepared.push({ query, name });
  }
  const excerpt =
    sql`translate(lower(coalesce(speaker_excerpt.text, chunk.text)), ${czechDiacritics}, ${asciiEquivalents})`;
  const vector = sql`to_tsvector('simple', ${excerpt})`;
  let required = sql`true`;
  for (const { query, name } of any ? [] : prepared.slice(1)) {
    const ts = name?.expand ? name.plan.surnameQuery : normalizedTsQuery(query);
    required = sql`${required} AND chunk.normalized_search_vector @@ to_tsquery('simple', ${ts})
      AND ${vector} @@ to_tsquery('simple', ${ts})`;
    if (name) {
      required = sql`${required} AND ${excerpt} ~ ${
        name.expand ? name.plan.surnamePattern : name.plan.fullPattern
      }`;
      if (name.expand && name.ambiguous) {
        required = sql`${required} AND
        (episode.id = ANY(${name.unambiguousEpisodes}::uuid[]) OR ${excerpt} ~ ${name.plan.fullPattern})`;
      }
    }
  }
  let preference = sql`0::float8`;
  for (const { topic } of plan.prefer) {
    preference = sql`${preference} + CASE WHEN ${vector} @@ to_tsquery('simple', ${
      normalizedTsQuery(topic)
    })
      THEN 1.25 ELSE 0 END`;
  }
  const groups: Awaited<ReturnType<typeof searchSingle>>[] = [];
  for (const { query, name } of any ? prepared : prepared.slice(0, 1)) {
    groups.push(
      await searchSingle(
        sql,
        { ...input, query },
        provider,
        { lexicalMatch: "all", diversifyEpisodes: true },
        people,
        { name, required, preference },
      ),
    );
  }
  const merged = Array.from(
    { length: input.limit },
    (_, i) => groups.flatMap((g) => g.slice(i, i + 1)),
  ).flat();
  if (plan.coverage === "ranked") merged.sort((a, b) => b.scores.combined - a.scores.combined);
  return selectDiverseExcerpts(merged, input.limit, input.episodeId ? input.limit : 2);
}

async function searchSingle(
  sql: Sql,
  input: SearchInput,
  provider: TextEmbeddingProvider,
  options: SearchOptions,
  knownPeople: string[],
  planned?: {
    name: NameContext | null;
    required: ReturnType<Sql["unsafe"]>;
    preference: ReturnType<Sql["unsafe"]>;
  },
) {
  const terms = lexicalTerms(input.query);
  const lexicalQuery = terms.map((term) => `"${term}"`).join(" OR ");
  const exactPhrase = terms.join(" ");
  const requireAllTerms = options.lexicalMatch === "all";
  const name = planned
    ? planned.name
    : requireAllTerms && input.mode === "fulltext"
    ? await resolveName(sql, input, knownPeople)
    : null;
  const normalizedQuery = name?.expand ? name.plan.surnameQuery : normalizedTsQuery(input.query);
  const diversify = options.diversifyEpisodes === true;
  let queryEmbedding: string | null = null;
  if (input.mode !== "fulltext") {
    queryEmbedding = vectorLiteral(await provider.embedQuery(input.query));
  }
  const candidateLimit = Math.max(input.limit, provider.candidateLimit, diversify ? 200 : 0);
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
          WHEN ${
    name !== null
  } THEN CASE WHEN translate(lower(coalesce(speaker_excerpt.text, chunk.text)),
            ${czechDiacritics}, ${asciiEquivalents}) ~ ${
    name?.plan.fullPattern ?? ""
  } THEN 2::float8 ELSE 0::float8 END
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
        END AS semantic_score, ${planned?.preference ?? sql`0::float8`} AS preference_score
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
        AND ${planned?.required ?? sql`true`}
        AND NOT episode.rag_excluded
        -- Levný indexový předvýběr před agregací výroků mluvčího. Každý jeho
        -- výrok je součástí chunku; finální shodu stále ověřujeme na jeho textu.
        AND (NOT ${requireAllTerms && input.mode === "fulltext"}
          OR chunk.normalized_search_vector @@ to_tsquery('simple', ${normalizedQuery}))
        AND (${name === null} OR translate(lower(coalesce(speaker_excerpt.text, chunk.text)),
          ${czechDiacritics}, ${asciiEquivalents}) ~ ${name?.plan.surnamePattern ?? ""})
        AND (${
    name === null || name.expand
  } OR translate(lower(coalesce(speaker_excerpt.text, chunk.text)),
          ${czechDiacritics}, ${asciiEquivalents}) ~ ${name?.plan.fullPattern ?? ""})
        AND (${!name || !name.ambiguous || !name.expand}
          OR episode.id = ANY(${name?.unambiguousEpisodes ?? []}::uuid[])
          OR translate(lower(coalesce(speaker_excerpt.text, chunk.text)), ${czechDiacritics}, ${asciiEquivalents}) ~ ${
    name?.plan.fullPattern ?? ""
  })
        AND (${input.personId ?? null}::uuid IS NULL OR speaker_excerpt.text IS NOT NULL)
        AND (${input.podcastId ?? null}::uuid IS NULL
          OR episode.podcast_id = ${input.podcastId ?? null}::uuid)
        AND (${input.episodeId ?? null}::uuid IS NULL
          OR episode.id = ${input.episodeId ?? null}::uuid)
        AND (${input.dateFrom ?? null}::date IS NULL
          OR episode.published_at >= ${input.dateFrom ?? null}::date)
        AND (${input.dateTo ?? null}::date IS NULL
          OR episode.published_at < (${input.dateTo ?? null}::date + interval '1 day'))
    ), scored AS (
      SELECT ranked.*,
        CASE ${input.mode}
          WHEN 'fulltext' THEN (preference_score + exact_score + CASE WHEN ${diversify}
            THEN LEAST(0.1, fulltext_score) ELSE fulltext_score END)
          WHEN 'semantic' THEN semantic_score
          ELSE (exact_score + LEAST(1, fulltext_score * 4) + GREATEST(0, semantic_score))
        END::float8 AS retrieval_score
      FROM ranked
      WHERE (${input.mode} = 'semantic' AND semantic_score > 0)
         OR (${input.mode} = 'fulltext' AND fulltext_score > 0)
         OR (${input.mode} = 'hybrid' AND (fulltext_score > 0 OR semantic_score > 0))
    ), deduplicated AS (
      SELECT scored.*, row_number() OVER (
        PARTITION BY episode_id, lower(regexp_replace(text, '[[:space:]]+', ' ', 'g'))
        ORDER BY start_seconds, chunk_id
      ) AS duplicate_rank
      FROM scored
    ), balanced AS (
      SELECT deduplicated.*, row_number() OVER (
        PARTITION BY episode_id ORDER BY retrieval_score DESC, start_seconds, chunk_id
      ) AS episode_rank
      FROM deduplicated
      WHERE NOT ${diversify} OR duplicate_rank = 1
    ), candidates AS (
      SELECT * FROM balanced
      ORDER BY CASE WHEN ${diversify} THEN episode_rank ELSE 0 END,
        retrieval_score DESC, published_at DESC NULLS LAST, start_seconds, chunk_id
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
    ORDER BY CASE WHEN ${diversify} THEN episode_rank ELSE 0 END,
      retrieval_score DESC, published_at DESC NULLS LAST, start_seconds, chunk_id
  `;

  const rerankerScores = input.mode === "fulltext" || rows.length === 0
    ? rows.map(() => null)
    : await provider.rerank(input.query, rows.map((row) => String(row.text)));
  const results = rows.map((row, index) => {
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
  );
  if (diversify) {
    return selectDiverseExcerpts(results, input.limit, input.episodeId ? input.limit : 2);
  }
  return results.sort((left, right) => right.scores.combined - left.scores.combined)
    .slice(0, input.limit);
}
