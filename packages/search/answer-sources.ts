import type { TextEmbeddingProvider } from "./providers.ts";
import type { Sql } from "../database/client.ts";
import {
  addTokenUsage,
  type AnswerGenerationProvider,
  type AnswerTokenUsage,
  type GroundingSource,
  type SearchPlanningResult,
} from "./answer.ts";
import {
  answerSearchQuery,
  asksAboutChange,
  focusedSearchTerms,
  foldSearchText,
  normalizedTsQuery,
} from "./query.ts";

interface SourceRequest {
  question: string;
  podcastId: string;
  personId?: string | undefined;
  episodeId?: string | undefined;
  dateFrom?: string | null | undefined;
  dateTo?: string | null | undefined;
}

function termGroup(text: string): string {
  return normalizedTsQuery(text);
}

type Passage = Omit<GroundingSource, "sourceId" | "publishedAt"> & { publishedAt: Date | null };

async function passages(
  sql: Sql,
  input: SourceRequest,
  groups: string[],
  timeline: boolean,
  limit = 8,
  names: string[] = [],
): Promise<GroundingSource[]> {
  if (!groups.length) return [];
  const topic = groups.map((group) => `(${group})`).join(" | ");
  const pairs = names.flatMap((a, i) => names.slice(i + 1).map((b) => `(${a} & ${b})`));
  const { dateFrom = null, dateTo = null } = input;
  const perPeriod = Math.max(1, Math.floor(limit / 8));
  // Check the indexed whole chunk first, then require the match again in the selected voice.
  const vector = input.personId
    ? sql`to_tsvector('simple', translate(lower(voice.excerpt), 'áčďéěíňóřšťúůýž', 'acdeeinorstuuyz'))`
    : sql`chunk.normalized_search_vector`;
  const comparisonBonus = pairs.length
    ? sql`CASE WHEN ${vector} @@ to_tsquery('simple', ${pairs.join(" | ")}) THEN 2 ELSE 0 END`
    : sql`0`;
  const voiceJoin = input.personId
    ? sql`CROSS JOIN LATERAL (
        SELECT string_agg(u.text, E'\n' ORDER BY link.position) AS excerpt
        FROM content_chunk_utterances link JOIN utterances u ON u.id = link.utterance_id
        WHERE link.content_chunk_id = chunk.id AND u.person_id = ${input.personId}
      ) voice`
    : sql``;
  const rows = await sql<Passage[]>`
    WITH hits AS (
      SELECT chunk.id, episode.id AS episode_id, episode.title AS episode_title, episode.published_at,
        COALESCE(chunk.playback_start_seconds, chunk.start_seconds) AS start_seconds, chunk.end_seconds,
        ${input.personId ? sql`voice.excerpt` : sql`chunk.text`} AS excerpt,
        ${comparisonBonus} + ts_rank_cd(${vector}, to_tsquery('simple', ${topic})) +
          ts_rank_cd(${vector}, to_tsquery('simple', ${groups[0]!})) AS score
      FROM content_chunks chunk
      JOIN episodes episode ON episode.id = chunk.episode_id
        AND episode.active_processing_run_id = chunk.processing_run_id
      ${voiceJoin}
      WHERE NOT episode.rag_excluded AND episode.podcast_id = ${input.podcastId}
        AND (${input.episodeId ?? null}::uuid IS NULL OR episode.id = ${input.episodeId ?? null})
        AND (${dateFrom}::date IS NULL OR episode.published_at >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR episode.published_at < ${dateTo}::date + interval '1 day')
        AND chunk.normalized_search_vector @@ to_tsquery('simple', ${topic})
        ${input.personId ? sql`AND ${vector} @@ to_tsquery('simple', ${topic})` : sql``}
    ), ranked AS (
      SELECT hits.*, row_number() OVER (PARTITION BY episode_id ORDER BY score DESC, start_seconds, id) AS in_episode
      FROM hits
    ), dated AS (
      SELECT id, score, published_at, ntile(3) OVER by_date AS period,
        row_number() OVER by_date AS oldest,
        row_number() OVER (ORDER BY published_at DESC, episode_id DESC) AS newest
      FROM ranked WHERE ${timeline} AND in_episode = 1 AND published_at IS NOT NULL
      WINDOW by_date AS (ORDER BY published_at, episode_id)
    ), periods AS (
      SELECT dated.*, row_number() OVER (PARTITION BY period ORDER BY score DESC, published_at DESC, id) AS in_period
      FROM dated
    ), chosen AS (
      SELECT ranked.* FROM ranked LEFT JOIN periods USING (id)
      ORDER BY CASE WHEN oldest = 1 OR newest = 1 THEN 0 WHEN in_period <= ${perPeriod} THEN 1
        WHEN ${timeline} AND in_episode = 1 THEN 2 ELSE 3 END,
        ranked.score DESC, ranked.published_at DESC NULLS LAST, ranked.start_seconds, ranked.id
      LIMIT ${limit}
    )
    SELECT episode_id, episode_title, published_at, start_seconds, end_seconds, excerpt,
      ARRAY(SELECT DISTINCT person.display_name
        FROM content_chunk_utterances link JOIN utterances u ON u.id = link.utterance_id
        JOIN persons person ON person.id = u.person_id
        WHERE link.content_chunk_id = chosen.id
          AND (${input.personId ?? null}::uuid IS NULL OR person.id = ${input.personId ?? null})
        ORDER BY person.display_name) AS speaker_names
    FROM chosen
    ORDER BY CASE WHEN ${timeline} THEN published_at END NULLS LAST,
      score DESC, published_at DESC NULLS LAST, start_seconds, id
  `;
  return rows.map((row, i) => ({
    ...row,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    sourceId: `source-${i + 1}`,
  }));
}

export async function findAnswerSources(
  sql: Sql,
  input: SourceRequest,
  planner: Pick<AnswerGenerationProvider, "expandSearch"> | null,
  reranker?: Pick<TextEmbeddingProvider, "rerank" | "minRerankScore" | "candidateLimit">,
  onPhase?: (phase: "plan" | "rerank") => void,
  initialSources?: GroundingSource[],
): Promise<{ sources: GroundingSource[]; usage?: AnswerTokenUsage; warnings: string[] }> {
  const [speaker] = input.personId
    ? await sql<
      { displayName: string }[]
    >`SELECT display_name FROM persons WHERE id = ${input.personId}`
    : [];
  const focused = answerSearchQuery(input.question, speaker?.displayName);
  const original = termGroup(focused);
  const groups = new Set(original ? [original] : []);
  const timeline = asksAboutChange(input.question);
  const initial = initialSources ?? await passages(sql, input, [...groups], timeline);
  if (!planner) return { sources: initial, warnings: [] };
  const planWith = (hints: GroundingSource[], previousNames?: string[]) =>
    planner.expandSearch({
      question: input.question,
      ...(previousNames ? { previousNames } : {}),
      ...(speaker ? { speaker: speaker.displayName } : {}),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      hints: hints.slice(0, 4).map(({ episodeTitle, publishedAt, excerpt }) => ({
        episodeTitle: episodeTitle.slice(0, 160),
        publishedAt,
        excerpt: excerpt.slice(0, previousNames ? 2000 : 480),
      })),
    });
  onPhase?.("plan");
  let plan;
  try {
    plan = await planWith(initial);
  } catch {
    return {
      sources: initial,
      warnings: ["Rozšíření dotazu nebylo dostupné; použil se původní dotaz."],
    };
  }
  const groupFor = (text: string) => termGroup(focusedSearchTerms(text, speaker?.displayName));
  const addPlan = (p: SearchPlanningResult) => {
    const names = [...new Set(p.names.map(groupFor).filter(Boolean))];
    for (const group of [...p.alternatives.map(groupFor), ...names]) if (group) groups.add(group);
    return names;
  };
  const names = addPlan(plan);
  const timeCoverage = timeline || plan.timeline;
  const limit = reranker ? Math.min(48, reranker.candidateLimit) : 8;
  const candidates = await passages(sql, input, [...groups], timeCoverage, limit, names);
  let usage = plan.usage;
  const warnings: string[] = [];
  const result = (sources: GroundingSource[]) => ({
    sources: sources.map((s, i) => ({ ...s, sourceId: `source-${i + 1}` })),
    warnings,
    ...(usage ? { usage } : {}),
  });
  if (!reranker || !candidates.length) return result(candidates);
  const rank = async (query: string, sources: GroundingSource[]) => {
    const scores = await reranker.rerank(
      query,
      sources.map((s) => s.excerpt.slice(0, 20000)),
      AbortSignal.timeout(60_000),
    );
    return sources.map((source, i) => ({ source, score: scores[i] ?? 0 })).sort((a, b) =>
      b.score - a.score
    );
  };
  const implicit = timeCoverage && !input.episodeId && plan.names.length > 0 &&
    !plan.names.some((name) => foldSearchText(input.question).includes(foldSearchText(name)));
  onPhase?.("rerank");
  let ranked;
  try {
    ranked = await rank(implicit ? input.question : plan.passageQuery, candidates);
  } catch {
    warnings.push("Posouzení relevance nebylo dostupné; zdroje byly vybrány fulltextem.");
    return result(await passages(sql, input, [...groups], timeCoverage, 8, names));
  }
  // The first pass may uncover a new comparison partner or a name only spoken in its short form.
  // Spend a second planning call only on timelines whose participants the user did not name.
  if (implicit && (ranked[0]?.score ?? 0) >= reranker.minRerankScore) {
    try {
      const refined = await planWith(ranked.slice(0, 4).map((r) => r.source), plan.names);
      usage = addTokenUsage(usage, refined.usage);
      const previousSize = groups.size;
      const refinedNames = addPlan(refined);
      if (groups.size > previousSize) {
        const extra = await passages(
          sql,
          input,
          [...groups],
          true,
          limit,
          refinedNames.length ? refinedNames : names,
        );
        const followup = await rank(refined.passageQuery, extra);
        // Preserve strong original matches even when the refined question scores them differently.
        ranked = [...ranked, ...followup].sort((a, b) => b.score - a.score);
      }
    } catch {
      warnings.push("Doplňující hledání nebylo dostupné; odpověď používá první výběr úryvků.");
    }
  }
  const seen = new Set<string>();
  const unique = ranked.filter(({ source }) => {
    const key = JSON.stringify([
      source.episodeId,
      source.startSeconds,
      source.endSeconds,
      source.excerpt,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sources = selectEvidence(
    unique.map((r) => r.source),
    unique.map((r) => r.score),
    timeCoverage,
    reranker.minRerankScore,
  );
  if (!sources.length && initial.length) {
    warnings.push(
      "Relevance rozšířených výsledků byla nízká; použily se přímé textové shody původního dotazu.",
    );
    return result(initial);
  }
  return result(sources);
}

/** Reserve space at either end of the timeline only for excerpts which address the question. */
export function selectEvidence(
  sources: GroundingSource[],
  scores: number[],
  timeline: boolean,
  minimum: number,
): GroundingSource[] {
  const ranked = sources.map((source, i) => ({ source, score: scores[i] ?? 0 })).sort((a, b) =>
    b.score - a.score
  );
  const best = ranked[0]?.score ?? 0;
  // A relative floor keeps incidental mentions out of the timeline. A weak overall match
  // cannot qualify just by being first or last in the archive.
  const floor = timeline && best >= minimum ? Math.max(minimum * 0.05, best * 0.025) : minimum;
  const eligible = ranked.filter((r) => r.score >= floor);
  if (!timeline) return eligible.slice(0, 8).map((r) => r.source);
  const episodes = new Map<string, GroundingSource>();
  for (const { source } of eligible) {
    if (!episodes.has(source.episodeId)) episodes.set(source.episodeId, source);
  }
  const dated = [...episodes.values()].filter((s) => s.publishedAt).sort((a, b) =>
    a.publishedAt!.localeCompare(b.publishedAt!)
  );
  const selected = new Set<GroundingSource>();
  if (dated.length) {
    selected.add(dated[0]!);
    selected.add(dated.at(-1)!);
  }
  for (const source of [...episodes.values(), ...eligible.map((r) => r.source)]) {
    if (selected.size >= 8) break;
    selected.add(source);
  }
  return [...selected].sort((a, b) => (a.publishedAt ?? "~").localeCompare(b.publishedAt ?? "~"));
}
