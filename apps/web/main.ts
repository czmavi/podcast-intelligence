import { dirname, fromFileUrl, isAbsolute, join, relative, resolve } from "@std/path";
import { z, ZodError } from "zod";
import { createDatabase } from "../../packages/database/client.ts";
import { podcastAutomationProgress } from "../../packages/database/podcast-automation.ts";
import {
  listTranscripts,
  scheduleTranscript,
  selectTranscript,
} from "../../packages/database/transcripts.ts";
import { requireSelectedTranscript } from "../../packages/database/transcript-selection.ts";
import {
  transcriptComparison,
  transcriptLabel,
  transcriptSelectionButton,
  transcriptVariantsSection,
} from "./services/transcripts.ts";
import { SystemIncidentRepository } from "../../packages/database/repositories/system-incidents.ts";
import {
  scheduleEpisode,
  scheduleMissingPodcastDownloads,
} from "../../packages/database/episode-processing.ts";
import { updateEpisodeRagExclusion } from "../../packages/database/episode-rag.ts";
import {
  nextSpeakerReviewEpisode,
  setEpisodeSpeakerReviewSkipped,
} from "../../packages/database/episode-review.ts";
import { searchFilterOptions } from "../../packages/database/search-filters.ts";
import { assignSpeaker } from "../../packages/database/speaker-assignment.ts";
import { enqueueGuestIdentificationAfterSpeakerAssignment } from "../../packages/database/automatic-speaker-identification.ts";
import { setSpeakerClusterIgnored } from "../../packages/database/speaker-ignore.ts";
import { updateUtteranceSpeaker } from "../../packages/database/utterance-speaker.ts";
import { suggestRegularHostsForEpisode } from "../../packages/database/speaker-matching.ts";
import {
  assignSpeakerSchema,
  createPersonSchema,
  createPodcastSchema,
  createTranscriptSchema,
  processEpisodeSchema,
  searchSchema,
  selectTranscriptSchema,
  updateEpisodeRagExclusionSchema,
  updateEpisodeSpeakerReviewSchema,
  updatePodcastAutoDownloadSchema,
  updatePodcastAutoProcessingSchema,
  updatePodcastAutoRefreshSchema,
  updatePodcastTranscriptAlignmentSchema,
  updateUtteranceSpeakerSchema,
  uuidSchema,
} from "../../packages/domain/schemas.ts";
import { jobQueue } from "../../packages/domain/job-types.ts";
import { DomainError, NotFoundError } from "../../packages/domain/errors.ts";
import { importPodcast } from "../../packages/podcast-rss/importer.ts";
import {
  addTokenUsage,
  type AnswerGenerationProvider,
  type GroundingSource,
} from "../../packages/search/answer.ts";
import {
  type AnswerProviderId,
  answerProviderIds,
  createAnswerProviders,
  openAiAnswerModels,
} from "../../packages/search/answer-providers.ts";
import { search, searchWithPlan } from "../../packages/search/search.ts";
import { answerSearchQuery, asksAboutChange } from "../../packages/search/query.ts";
import { findAnswerSources as findTimelineSources } from "../../packages/search/answer-sources.ts";
import { LocalTextEmbeddingProvider } from "../../packages/search/providers.ts";
import { loadConfig } from "../../packages/shared/config.ts";
import { formatTimestamp } from "../../packages/shared/time.ts";
import { htmlToPlainText } from "../../packages/shared/text.ts";
import { PushoverClient } from "../../packages/shared/pushover.ts";
import {
  escapeHtml,
  layout,
  podcastSettingsBody,
  podcastSettingsLink,
  storageUsageHtml,
  transcriptLine,
} from "./services/html.ts";
import {
  assignInterceptionSpeaker,
  automaticallyAssignInterceptionSpeakers,
  scheduleInterception,
} from "../../packages/database/interceptions.ts";
import { interceptionStorage } from "../../packages/shared/paths.ts";
import { json, readJson, requireMutationAuth } from "./services/http.ts";
import { jobDurationHtml } from "./services/jobs.ts";
import { estimateAutomationDuration } from "./services/automation.ts";
import { interceptionPages } from "./services/interception-pages.ts";
import {
  episodeActionAppearance,
  episodeActionConfirmation,
  episodeFilterLabels,
  episodeFilterValues,
  episodeRagExclusionControl,
  episodeSpeakerAssignmentBadge,
  episodeSpeakerReviewControl,
  episodeStatusBadge,
  episodeStatusesForFilter,
  formatEpisodePublishedDate,
  isCompactSpeakerCard,
  isVerifiedSpeakerAssignment,
  nextSpeakerAssignmentEpisodeLink,
} from "./services/episodes.ts";

const config = loadConfig();
const sql = createDatabase(config);
const incidents = new SystemIncidentRepository(sql);
const pushover = new PushoverClient(config);
const embeddingProvider = new LocalTextEmbeddingProvider(config);
const answerProviders = createAnswerProviders(config);
const thinkingCapProvider = answerProviders.get("thinking-cap");
const defaultAnswerProviderId = answerProviders.get("gpt-6.1-sol") ? "gpt-6.1-sol" : "thinking-cap";
const staticRoot = join(dirname(fromFileUrl(import.meta.url)), "static");

const askInputSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  podcastId: uuidSchema,
  episodeId: uuidSchema.optional(),
  personId: uuidSchema.optional(),
  dateFrom: z.string().date().nullable().optional(),
  dateTo: z.string().date().nullable().optional(),
  answerProvider: z.enum(answerProviderIds).optional(),
});

type AskInput = z.infer<typeof askInputSchema>;

function answerProviderFor(input: AskInput): {
  id: AnswerProviderId;
  provider: AnswerGenerationProvider | null;
} {
  const id = input.answerProvider ?? defaultAnswerProviderId;
  return { id, provider: answerProviders.get(id) ?? null };
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs").trim()
    .replace(/\s+/g, " ");
}

function feedMissingWarning(episode: Record<string, unknown>): string {
  if (episode.isPresentInFeed !== false) return "";
  const since = episode.missingFromFeedSince
    ? ` od ${new Date(String(episode.missingFromFeedSince)).toLocaleDateString("cs")}`
    : "";
  return `<div class="alert alert-warning"><strong>Mimo RSS feed.</strong> Epizoda už v RSS není${since}.
    Již uložené audio a všechna zpracovaná data zůstávají zachovaná.</div>`;
}

function podcastInitial(name: unknown): string {
  return String(name || "P").trim().charAt(0).toLocaleUpperCase("cs");
}

function podcastArtwork(name: unknown, imageUrl: unknown, large = false): string {
  const sizeClass = large ? " podcast-artwork-large" : "";
  return `<span class="podcast-artwork${sizeClass}">
    <span class="podcast-monogram" aria-hidden="true">${escapeHtml(podcastInitial(name))}</span>
    ${
    imageUrl
      ? `<img class="podcast-logo" src="${escapeHtml(imageUrl)}" alt="Logo ${
        escapeHtml(name)
      }" loading="lazy" referrerpolicy="no-referrer">`
      : ""
  }
  </span>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

function routeId(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  if (!match?.[1]) return null;
  return uuidSchema.parse(match[1]);
}

async function recentJobs() {
  return await sql`
    SELECT job.*,
      CASE WHEN job.type = 'DOWNLOAD_AUDIO' THEN 'download' ELSE 'processing' END AS queue,
      episode.title AS episode_title,
      episode.id AS episode_id,
      COALESCE(episode_podcast.name, entity_podcast.name) AS podcast_name,
      COALESCE(episode_podcast.id, entity_podcast.id) AS podcast_id
    FROM jobs job
    LEFT JOIN episodes episode
      ON job.entity_type = 'episode' AND episode.id = job.entity_id
    LEFT JOIN podcasts episode_podcast ON episode_podcast.id = episode.podcast_id
    LEFT JOIN podcasts entity_podcast
      ON job.entity_type = 'podcast' AND entity_podcast.id = job.entity_id
    WHERE job.created_at >= now() - interval '24 hours'
    ORDER BY CASE WHEN job.status IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END,
      job.created_at DESC
    LIMIT 100
  `;
}

async function findAnswerSources(
  input: AskInput,
  onPhase?: (phase: "plan" | "rerank") => void,
): ReturnType<typeof findTimelineSources> {
  const provider = answerProviderFor(input).provider;
  const speakerRows = input.personId
    ? await sql`SELECT display_name FROM persons WHERE id = ${input.personId}`
    : [];
  const selectedSpeakerName = speakerRows[0] ? String(speakerRows[0].displayName) : undefined;
  const query = {
    query: answerSearchQuery(input.question, selectedSpeakerName),
    podcastId: input.podcastId,
    ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    ...(input.personId ? { personId: input.personId } : {}),
    ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
    ...(input.dateTo ? { dateTo: input.dateTo } : {}),
    limit: 16,
    mode: "fulltext" as const,
    precision: "balanced" as const,
  };
  const asSources = (results: Awaited<ReturnType<typeof search>>) =>
    results.map((result, index) => ({
      sourceId: `source-${index + 1}`,
      episodeId: result.episodeId,
      episodeTitle: result.episodeTitle,
      publishedAt: result.publishedAt,
      startSeconds: result.startSeconds,
      endSeconds: result.endSeconds,
      speakerNames: (result.persons as Array<{ displayName: string }>).map((p) => p.displayName),
      excerpt: result.text,
    }));
  const directSearch = () =>
    search(sql, query, embeddingProvider, { lexicalMatch: "all", diversifyEpisodes: true });
  if (asksAboutChange(input.question)) {
    const initial = asSources(await directSearch()).slice(0, 8);
    return await findTimelineSources(sql, input, provider, embeddingProvider, onPhase, initial);
  }
  onPhase?.("plan");
  const start = performance.now();
  const plan = await provider?.planSearch?.(input.question, selectedSpeakerName).catch(() => null);
  console.info(
    JSON.stringify({
      event: "search_planning",
      planned: Boolean(plan),
      ms: Math.round(performance.now() - start),
    }),
  );
  const results = plan
    ? await searchWithPlan(sql, query, embeddingProvider, plan)
    : await directSearch();
  return { sources: asSources(results), warnings: [] };
}

function streamAnswer(input: AskInput): Response {
  const selected = answerProviderFor(input);
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sources: GroundingSource[] = [];
      const send = (event: Record<string, unknown>) => {
        if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        send({ type: "phase", phase: "search", message: "Hledám relevantní zdroje" });
        const retrieval = await findAnswerSources(
          input,
          (phase) =>
            send({
              type: "phase",
              phase,
              message: phase === "plan"
                ? "Rozšiřuji hledání podle otázky a prvních shod"
                : "Porovnávám úryvky s otázkou",
            }),
        );
        sources = retrieval.sources;
        if (cancelled) return;
        send({
          type: "phase",
          phase: "sources",
          message: `Vybráno úryvků pro odpověď: ${sources.length} z ${
            new Set(sources.map((source) => source.episodeId)).size
          } epizod`,
        });
        if (!selected.provider) {
          send({
            type: "complete",
            answer: null,
            confidence: "low",
            sourceIds: [],
            sources,
            warnings: [
              `Generativní provider ${selected.id} není nakonfigurován; vracím pouze dohledané zdrojové úseky.`,
            ],
          });
          return;
        }
        if (sources.length === 0) {
          send({
            type: "complete",
            answer: null,
            confidence: "low",
            sourceIds: [],
            sources,
            warnings: [...retrieval.warnings, "Pro odpověď nebyly nalezeny žádné zdrojové úseky."],
            ...(retrieval.usage ? { usage: retrieval.usage } : {}),
          });
          return;
        }
        for await (
          const event of selected.provider.streamGroundedAnswer({
            question: input.question,
            sources,
          })
        ) {
          if (cancelled) break;
          if (event.type === "complete") {
            send({
              type: "complete",
              ...event.answer,
              sources,
              warnings: retrieval.warnings,
              usage: addTokenUsage(retrieval.usage, event.usage),
            });
          } else {
            send(event);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Neznámá chyba.";
        console.error(JSON.stringify({ event: "answer_stream_failed", message }));
        send({
          type: "error",
          message: "Generování odpovědi selhalo; vracím pouze dohledané zdrojové úseky.",
          sources,
        });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}

function jobProgress(job: Record<string, unknown>): string {
  const percent = job.progressPercent === null || job.progressPercent === undefined
    ? null
    : Math.round(Number(job.progressPercent));
  const count = job.progressCurrent !== null && job.progressCurrent !== undefined &&
      job.progressTotal !== null && job.progressTotal !== undefined
    ? `${escapeHtml(job.progressCurrent)}/${escapeHtml(job.progressTotal)}`
    : "";
  if (percent === null) return escapeHtml(job.progressMessage ?? "—");
  return `<div class="progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0"
    aria-valuemax="100"><span style="width:${percent}%"></span></div>
    <small>${percent} % ${count}${count ? " · " : ""}${
    escapeHtml(job.progressMessage ?? "")
  }</small>`;
}

function jobRelation(job: Record<string, unknown>): string {
  if (job.episodeId) {
    return `<a href="/episodes/${job.episodeId}">${escapeHtml(job.episodeTitle)}</a>
      <small class="muted">${escapeHtml(job.podcastName ?? "")}</small>`;
  }
  if (job.podcastId) {
    return `<a href="/podcasts/${job.podcastId}">${escapeHtml(job.podcastName)}</a>`;
  }
  return `${escapeHtml(job.entityType)} · ${escapeHtml(job.entityId)}`;
}

function jobRow(job: Record<string, unknown>): string {
  const queue = jobQueue(String(job.type));
  const queueLabel = queue === "download" ? "Stahování" : "Zpracování";
  return `<tr><td>${jobRelation(job)}</td>
    <td><span class="badge ${
    queue === "download" ? "badge-info" : "badge-neutral"
  }">${queueLabel}</span></td><td>${escapeHtml(job.type)}</td>
    <td>${escapeHtml(job.status)}</td><td>${jobProgress(job)}</td>
    <td>${jobDurationHtml(job)}</td><td>${escapeHtml(job.attempts)}/${
    escapeHtml(job.maxAttempts)
  }</td>
    <td class="danger">${escapeHtml(job.error ?? "")}</td></tr>`;
}

async function storedAudioResponse(
  request: Request,
  storedPath: string | undefined,
  mimeType: unknown,
): Promise<Response> {
  if (!storedPath) throw new NotFoundError("Audio");
  const root = resolve(config.STORAGE_ROOT);
  const path = resolve(storedPath);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DomainError("Audio cesta je mimo storage.", "INVALID_STORAGE_PATH", 500);
  }
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new NotFoundError("Audio soubor");
    throw error;
  }
  const size = stat.size;
  const mime = String(mimeType || "application/octet-stream");
  const range = request.headers.get("range");
  const headers = new Headers({
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (!range) {
    headers.set("content-length", String(size));
    return new Response((await Deno.open(path, { read: true })).readable, { headers });
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
    start >= size
  ) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  const file = await Deno.open(path, { read: true });
  await file.seek(start, Deno.SeekMode.Start);
  const length = end - start + 1;
  headers.set("content-length", String(length));
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  if (request.method === "HEAD") {
    file.close();
    return new Response(null, { status: 206, headers });
  }
  let remaining = length;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = new Uint8Array(Math.min(64 * 1024, remaining));
      const read = await file.read(buffer);
      if (read === null || read === 0) {
        file.close();
        controller.close();
        return;
      }
      remaining -= read;
      controller.enqueue(buffer.subarray(0, read));
      if (remaining === 0) {
        file.close();
        controller.close();
      }
    },
    cancel() {
      file.close();
    },
  });
  return new Response(
    stream,
    { status: 206, headers },
  );
}

async function audioResponse(request: Request, episodeId: string): Promise<Response> {
  const row = (await sql`SELECT original_audio_path, audio_mime_type
    FROM episodes WHERE id = ${episodeId}`)[0];
  return await storedAudioResponse(
    request,
    row?.originalAudioPath as string | undefined,
    row?.audioMimeType,
  );
}

async function api(request: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) return null;
  if (!["GET", "HEAD"].includes(request.method)) requireMutationAuth(request, config);

  if (pathname === "/api/odposlechy" && request.method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 500 * 1024 * 1024) {
      throw new DomainError("MP3 může mít nejvýše 500 MB.", "UPLOAD_TOO_LARGE", 413);
    }
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File) || file.size === 0) {
      throw new DomainError("Vyberte MP3 soubor.", "AUDIO_REQUIRED");
    }
    if (
      file.size > 500 * 1024 * 1024 ||
      (!file.name.toLocaleLowerCase().endsWith(".mp3") && file.type !== "audio/mpeg")
    ) {
      throw new DomainError("Je povolen pouze MP3 soubor do 500 MB.", "INVALID_AUDIO");
    }
    const input = z.object({
      title: z.string().trim().min(1).max(250),
      speakerCount: z.coerce.number().int().min(1).max(10),
      processingMode: z.enum(["segment", "overlap", "overlap_asr_corrected"]),
    }).parse(Object.fromEntries(form.entries()));
    const id = crypto.randomUUID();
    const paths = interceptionStorage(config.STORAGE_ROOT, id);
    await Deno.mkdir(paths.base, { recursive: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await Deno.writeFile(paths.original, bytes, { createNew: true });
    const result = await scheduleInterception(sql, {
      id,
      title: input.title,
      filename: file.name,
      path: paths.original,
      mimeType: "audio/mpeg",
      byteSize: file.size,
      sha256,
      speakerCount: input.speakerCount,
      processingMode: input.processingMode,
    }, config.MAX_JOB_ATTEMPTS);
    return json(result, 202);
  }
  let interceptionId = routeId(pathname, /^\/api\/odposlechy\/([^/]+)$/);
  if (interceptionId && request.method === "GET") {
    const row = (await sql`SELECT interception.*, job.progress_percent, job.progress_message,
      job.status AS job_status FROM interceptions interception LEFT JOIN LATERAL (
        SELECT * FROM jobs WHERE entity_type = 'interception' AND entity_id = interception.id
        ORDER BY created_at DESC LIMIT 1
      ) job ON true WHERE interception.id = ${interceptionId}`)[0];
    if (!row) throw new NotFoundError("Odposlech");
    return json(row);
  }
  interceptionId = routeId(pathname, /^\/api\/odposlechy\/([^/]+)\/audio$/);
  if (interceptionId && ["GET", "HEAD"].includes(request.method)) {
    const row = (await sql`SELECT original_audio_path, audio_mime_type FROM interceptions
      WHERE id = ${interceptionId}`)[0];
    return await storedAudioResponse(
      request,
      row?.originalAudioPath as string | undefined,
      row?.audioMimeType,
    );
  }
  interceptionId = routeId(pathname, /^\/api\/odposlechy\/([^/]+)\/automaticky-priradit$/);
  if (interceptionId && request.method === "POST") {
    const assigned = await automaticallyAssignInterceptionSpeakers(sql, interceptionId);
    return json({ assigned: assigned.length });
  }
  if (pathname === "/api/odposlechy/osoby" && request.method === "POST") {
    const input = z.object({
      displayName: z.string().trim().min(1).max(200),
      description: z.string().trim().max(4000).optional(),
    }).parse(await readJson(request));
    const rows = await sql`INSERT INTO interception_persons
      (display_name, normalized_name, description) VALUES (${input.displayName},
      ${normalizedName(input.displayName)}, ${input.description ?? null}) RETURNING *`;
    return json(rows[0], 201);
  }
  const interceptionSpeakerId = routeId(pathname, /^\/api\/odposlechy\/hlasy\/([^/]+)\/priradit$/);
  if (interceptionSpeakerId && request.method === "POST") {
    const input = z.object({
      personId: uuidSchema.optional(),
      displayName: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(4000).optional(),
    }).parse(await readJson(request));
    return json(await assignInterceptionSpeaker(sql, interceptionSpeakerId, input));
  }

  if (pathname === "/api/podcasts" && request.method === "POST") {
    const input = createPodcastSchema.parse(await readJson(request));
    return json(await importPodcast(sql, input.rssUrl, config.MAX_JOB_ATTEMPTS), 201);
  }
  if (pathname === "/api/podcasts" && request.method === "GET") {
    return json(
      await sql`
      SELECT podcast.*, count(episode.id)::int AS episode_count
      FROM podcasts podcast LEFT JOIN episodes episode ON episode.podcast_id = podcast.id
      GROUP BY podcast.id ORDER BY podcast.created_at DESC
    `,
    );
  }
  let id = routeId(pathname, /^\/api\/podcasts\/([^/]+)$/);
  if (id && request.method === "GET") {
    const rows = await sql`SELECT * FROM podcasts WHERE id = ${id}`;
    if (!rows[0]) throw new NotFoundError("Podcast");
    return json(rows[0]);
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/import$/);
  if (id && request.method === "POST") {
    const rows = await sql`SELECT rss_url FROM podcasts WHERE id = ${id}`;
    if (!rows[0]) throw new NotFoundError("Podcast");
    return json(await importPodcast(sql, String(rows[0].rssUrl), config.MAX_JOB_ATTEMPTS));
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/auto-processing$/);
  if (id && request.method === "PATCH") {
    const input = updatePodcastAutoProcessingSchema.parse(await readJson(request));
    const rows = await sql`
      UPDATE podcasts SET auto_process_enabled = ${input.enabled}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, auto_process_enabled
    `;
    if (!rows[0]) throw new NotFoundError("Podcast");
    return json(rows[0]);
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/auto-download$/);
  if (id && request.method === "PATCH") {
    const input = updatePodcastAutoDownloadSchema.parse(await readJson(request));
    const rows = await sql`
      UPDATE podcasts SET auto_download_enabled = ${input.enabled}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, auto_download_enabled
    `;
    if (!rows[0]) throw new NotFoundError("Podcast");
    return json(rows[0]);
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/auto-refresh$/);
  if (id && request.method === "PATCH") {
    const input = updatePodcastAutoRefreshSchema.parse(await readJson(request));
    const rows = await sql`
      UPDATE podcasts SET auto_refresh_enabled = ${input.enabled}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, auto_refresh_enabled
    `;
    if (!rows[0]) throw new NotFoundError("Podcast");
    return json(rows[0]);
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/transcript-alignment$/);
  if (id && request.method === "PATCH") {
    const input = updatePodcastTranscriptAlignmentSchema.parse(await readJson(request));
    const rows = await sql`
      UPDATE podcasts SET transcript_alignment_mode = ${input.mode}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, transcript_alignment_mode
    `;
    if (!rows[0]) throw new NotFoundError("Podcast");
    return json(rows[0]);
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/download-missing$/);
  if (id && request.method === "POST") {
    const result = await scheduleMissingPodcastDownloads(sql, id, config.MAX_JOB_ATTEMPTS);
    return json({
      ...result,
      message: result.queuedCount > 0
        ? `Do fronty bylo zařazeno ${result.queuedCount} epizod ke stažení.`
        : "Všechna dostupná chybějící audia už jsou stažená nebo ve frontě.",
    }, 202);
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/automation-status$/);
  if (id && request.method === "GET") {
    const podcast = (await sql`
      SELECT id, auto_process_enabled FROM podcasts WHERE id = ${id}
    `)[0];
    if (!podcast) throw new NotFoundError("Podcast");
    const { counts, durations } = await podcastAutomationProgress(sql, id);
    return json({
      podcastId: id,
      enabled: Boolean(podcast.autoProcessEnabled),
      ...counts,
      ...estimateAutomationDuration(durations, counts.remainingCount),
    });
  }
  id = routeId(pathname, /^\/api\/podcasts\/([^/]+)\/episodes$/);
  if (id && request.method === "GET") {
    return json(
      await sql`SELECT * FROM episodes WHERE podcast_id = ${id}
      ORDER BY published_at DESC NULLS LAST`,
    );
  }
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/process$/);
  if (id && request.method === "POST") {
    const input = processEpisodeSchema.parse(await readJson(request));
    return json(await scheduleEpisode(sql, id, config.MAX_JOB_ATTEMPTS, input.mode), 202);
  }
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/transcripts$/);
  if (id && request.method === "POST") {
    const input = createTranscriptSchema.parse(await readJson(request));
    if (input.provider === "elevenlabs" && !config.ELEVENLABS_API_KEY) {
      throw new DomainError("ElevenLabs zatím není nakonfigurovaný.", "SCRIBE_NOT_CONFIGURED", 409);
    }
    return json(await scheduleTranscript(sql, id, input, config.MAX_JOB_ATTEMPTS), 202);
  }
  if (id && request.method === "GET") return json(await listTranscripts(sql, id));
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/transcripts\/select$/);
  if (id && request.method === "POST") {
    const input = selectTranscriptSchema.parse(await readJson(request));
    return json(await selectTranscript(sql, id, input.runId, config.MAX_JOB_ATTEMPTS), 202);
  }
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/rag-exclusion$/);
  if (id && request.method === "PATCH") {
    const input = updateEpisodeRagExclusionSchema.parse(await readJson(request));
    return json(await updateEpisodeRagExclusion(sql, config.STORAGE_ROOT, id, input.excluded));
  }
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/speaker-review$/);
  if (id && request.method === "PATCH") {
    const input = updateEpisodeSpeakerReviewSchema.parse(await readJson(request));
    return json(await setEpisodeSpeakerReviewSkipped(sql, id, input.skipped));
  }
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/suggest-speakers$/);
  if (id && request.method === "POST") {
    const suggestions = await suggestRegularHostsForEpisode(sql, id);
    return json({
      suggestions,
      message: `Nalezeno návrhů: ${suggestions.length}. Každý je potřeba ručně potvrdit.`,
    });
  }
  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/audio$/);
  if (id && ["GET", "HEAD"].includes(request.method)) return await audioResponse(request, id);

  if (pathname === "/api/persons" && request.method === "GET") {
    const podcastIdValue = url.searchParams.get("podcastId");
    if (!podcastIdValue) {
      return json(await sql`SELECT * FROM persons ORDER BY display_name`);
    }
    const podcastId = uuidSchema.parse(podcastIdValue);
    return json(
      await sql`
      SELECT person.*, association.role AS podcast_role
      FROM podcast_persons association
      JOIN persons person ON person.id = association.person_id
      WHERE association.podcast_id = ${podcastId}
      ORDER BY association.role, person.display_name
    `,
    );
  }
  if (pathname === "/api/persons" && request.method === "POST") {
    const input = createPersonSchema.omit({ isRegularHost: true }).extend({
      podcastId: uuidSchema,
      role: z.enum(["moderator", "guest"]),
    }).parse(await readJson(request));
    const person = await sql.begin(async (tx) => {
      const podcast = (await tx`SELECT id FROM podcasts WHERE id = ${input.podcastId}`)[0];
      if (!podcast) throw new NotFoundError("Podcast");
      const rows = await tx`
        INSERT INTO persons (display_name, normalized_name, description, is_regular_host)
        VALUES (${input.displayName}, ${normalizedName(input.displayName)},
          ${input.description ?? null}, ${input.role === "moderator"})
        RETURNING *
      `;
      const created = rows[0];
      if (!created) throw new Error("Novou osobu se nepodařilo vytvořit.");
      await tx`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${input.podcastId}, ${created.id}, ${input.role})
      `;
      return { ...created, podcastRole: input.role };
    });
    return json(person, 201);
  }
  id = routeId(pathname, /^\/api\/persons\/([^/]+)$/);
  if (id && request.method === "GET") {
    const rows = await sql`SELECT * FROM persons WHERE id = ${id}`;
    if (!rows[0]) throw new NotFoundError("Osoba");
    return json(rows[0]);
  }
  if (id && request.method === "PATCH") {
    const input = createPersonSchema.partial().parse(await readJson(request));
    const existing = await sql`SELECT * FROM persons WHERE id = ${id}`;
    if (!existing[0]) throw new NotFoundError("Osoba");
    const displayName = input.displayName ?? String(existing[0].displayName);
    const rows = await sql`
      UPDATE persons SET display_name = ${displayName},
        normalized_name = ${normalizedName(displayName)},
        description = ${
      input.description === undefined ? existing[0].description : input.description
    },
        is_regular_host = ${input.isRegularHost ?? existing[0].isRegularHost}, updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    return json(rows[0]);
  }

  id = routeId(pathname, /^\/api\/episodes\/([^/]+)\/participants$/);
  if (id && request.method === "GET") {
    return json(
      await sql`
      SELECT participant.*, person.display_name
      FROM episode_participants participant
      JOIN persons person ON person.id = participant.person_id
      WHERE participant.episode_id = ${id} ORDER BY participant.role, person.display_name
    `,
    );
  }
  if (id && request.method === "POST") {
    const input = z.object({
      personId: uuidSchema,
      role: z.enum(["moderator", "guest"]),
    }).parse(await readJson(request));
    await sql.begin(async (tx) => {
      const episode = (await tx`SELECT podcast_id FROM episodes WHERE id = ${id}`)[0];
      if (!episode) throw new NotFoundError("Epizoda");
      const person = (await tx`SELECT id FROM persons WHERE id = ${input.personId}`)[0];
      if (!person) throw new NotFoundError("Osoba");
      await tx`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${episode.podcastId}, ${input.personId}, ${input.role})
        ON CONFLICT (podcast_id, person_id)
        DO UPDATE SET role = EXCLUDED.role, updated_at = now()
      `;
      await tx`
        INSERT INTO episode_participants (episode_id, person_id, role, source, confidence)
        VALUES (${id}, ${input.personId}, ${input.role}, 'manual', 1)
        ON CONFLICT (episode_id, person_id)
        DO UPDATE SET role = EXCLUDED.role, source = 'manual', confidence = 1
      `;
    });
    return json({ ok: true }, 201);
  }
  const participantMatch = pathname.match(
    /^\/api\/episodes\/([^/]+)\/participants\/([^/]+)$/,
  );
  if (participantMatch && request.method === "DELETE") {
    const episodeId = uuidSchema.parse(participantMatch[1]);
    const personId = uuidSchema.parse(participantMatch[2]);
    await sql`DELETE FROM episode_participants
      WHERE episode_id = ${episodeId} AND person_id = ${personId}`;
    return new Response(null, { status: 204 });
  }

  id = routeId(pathname, /^\/api\/speaker-clusters\/([^/]+)\/assign$/);
  if (id && request.method === "POST") {
    const input = assignSpeakerSchema.parse(await readJson(request));
    const assignment = await assignSpeaker(sql, id, input);
    const guestIdentificationJobId = await enqueueGuestIdentificationAfterSpeakerAssignment(
      sql,
      id,
      config.MAX_JOB_ATTEMPTS,
    );
    return json({ ok: true, ...assignment, guestIdentificationJobId });
  }
  id = routeId(pathname, /^\/api\/speaker-clusters\/([^/]+)\/reject$/);
  if (id && request.method === "POST") {
    const clusterId = id;
    await sql.begin(async (tx) => {
      const cluster = (await tx`SELECT episode_id, processing_run_id FROM speaker_clusters
        WHERE id = ${clusterId}`)[0];
      if (!cluster) throw new NotFoundError("Speaker cluster");
      await requireSelectedTranscript(tx, cluster.episodeId, cluster.processingRunId);
      await tx`UPDATE speaker_clusters SET assigned_person_id = NULL, identity_status = 'rejected',
        identity_confidence = NULL, identity_source = 'manual', updated_at = now()
        WHERE id = ${clusterId}`;
      await tx`UPDATE utterances SET person_id = NULL WHERE speaker_cluster_id = ${clusterId}
        AND speaker_assignment_source = 'cluster'`;
    });
    return json({ ok: true });
  }
  id = routeId(pathname, /^\/api\/speaker-clusters\/([^/]+)\/ignore$/);
  if (id && request.method === "POST") {
    return json({ ok: true, ...await setSpeakerClusterIgnored(sql, id, true) });
  }
  id = routeId(pathname, /^\/api\/speaker-clusters\/([^/]+)\/restore$/);
  if (id && request.method === "POST") {
    return json({ ok: true, ...await setSpeakerClusterIgnored(sql, id, false) });
  }

  id = routeId(pathname, /^\/api\/utterances\/([^/]+)\/speaker$/);
  if (id && request.method === "PATCH") {
    const input = updateUtteranceSpeakerSchema.parse(await readJson(request));
    return json({ ok: true, ...await updateUtteranceSpeaker(sql, id, input) });
  }

  if (pathname === "/api/search" && request.method === "POST") {
    const input = searchSchema.parse(await readJson(request));
    try {
      return json({ results: await search(sql, input, embeddingProvider), warnings: [] });
    } catch (error) {
      if (input.mode !== "hybrid") throw error;
      const fallback = { ...input, mode: "fulltext" as const };
      return json({
        results: await search(sql, fallback, embeddingProvider),
        warnings: ["Semantic search není dostupný; použil se fulltext."],
      });
    }
  }
  if (pathname === "/api/search/filters" && request.method === "GET") {
    const podcastId = uuidSchema.parse(url.searchParams.get("podcastId"));
    const episodeIdValue = url.searchParams.get("episodeId");
    const episodeId = episodeIdValue ? uuidSchema.parse(episodeIdValue) : undefined;
    return json(await searchFilterOptions(sql, podcastId, episodeId));
  }
  if (pathname === "/api/ask" && request.method === "POST") {
    const input = askInputSchema.parse(await readJson(request));
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      return streamAnswer(input);
    }
    const selected = answerProviderFor(input);
    const { sources, warnings } = await findAnswerSources(input);
    if (!selected.provider) {
      return json({
        answer: null,
        confidence: "low",
        sourceIds: [],
        sources,
        warnings: [
          `Generativní provider ${selected.id} není nakonfigurován; vracím pouze dohledané zdrojové úseky.`,
        ],
      });
    }
    if (sources.length === 0) {
      return json({
        answer: null,
        confidence: "low",
        sourceIds: [],
        sources,
        warnings: [...warnings, "Pro odpověď nebyly nalezeny žádné zdrojové úseky."],
      });
    }
    try {
      const generated = await selected.provider.generateGroundedAnswer({
        question: input.question,
        sources,
      });
      return json({ ...generated, sources, warnings });
    } catch (error) {
      console.error(JSON.stringify({
        event: "answer_generation_failed",
        message: error instanceof Error ? error.message : "Neznámá chyba.",
      }));
      return json({
        answer: null,
        confidence: "low",
        sourceIds: [],
        sources,
        warnings: [
          ...warnings,
          "Generování odpovědi selhalo; vracím pouze dohledané zdrojové úseky.",
        ],
      });
    }
  }
  if (pathname === "/api/jobs" && request.method === "GET") {
    return json(await recentJobs());
  }
  if (pathname === "/api/system-incidents" && request.method === "GET") {
    return json(await incidents.list());
  }
  id = routeId(pathname, /^\/api\/system-incidents\/([^/]+)\/accept$/);
  if (id && request.method === "POST") {
    const incident = await incidents.accept(id, "web");
    if (!incident) throw new NotFoundError("Incident");
    return json({ ok: true, incident });
  }
  if (pathname === "/api/system-incidents/test-notification" && request.method === "POST") {
    const sent = await pushover.send(
      "Test Podcast Intelligence",
      "Pushover notifikace z webového portálu fungují.",
    );
    return json({ ok: true, message: "Testovací notifikace byla odeslána.", ...sent });
  }
  throw new NotFoundError("API endpoint");
}

function incidentChecks(details: unknown): string {
  const parsed = z.object({
    diagnostic: z.object({
      checks: z.array(z.object({ name: z.string(), ok: z.boolean(), message: z.string() })),
    }),
  }).safeParse(details);
  if (!parsed.success) return "";
  return `<ul class="incident-checks">${
    parsed.data.diagnostic.checks.map((check) =>
      `<li class="${check.ok ? "check-ok" : "check-failed"}">
        <strong>${escapeHtml(check.name)}</strong> — ${escapeHtml(check.message)}</li>`
    ).join("")
  }</ul>`;
}

function incidentCard(incident: Record<string, unknown>): string {
  const open = incident.status === "open";
  const notification = incident.lastNotifiedAt
    ? new Date(String(incident.lastNotifiedAt)).toLocaleString("cs")
    : "neodeslána";
  return `<article class="card incident-card ${open ? "incident-open" : "incident-accepted"}">
    <div class="row spread"><div class="row">
      <span class="badge ${open ? "badge-danger" : "badge-neutral"}">${
    open ? "Vyžaduje potvrzení" : "Potvrzeno"
  }</span>
      <span class="meta">Výskytů: ${escapeHtml(incident.occurrenceCount)}</span></div>
      <span class="meta">Naposledy ${
    new Date(String(incident.lastDetectedAt)).toLocaleString("cs")
  }</span></div>
    <h2>${escapeHtml(incident.title)}</h2><p>${escapeHtml(incident.message)}</p>
    ${incidentChecks(incident.details)}
    <p class="meta">První výskyt: ${
    new Date(String(incident.firstDetectedAt)).toLocaleString("cs")
  } · poslední notifikace: ${escapeHtml(notification)}${
    incident.acceptedAt
      ? ` · potvrzeno ${new Date(String(incident.acceptedAt)).toLocaleString("cs")}`
      : ""
  }</p>
    ${
    open
      ? `<button data-action="/api/system-incidents/${incident.id}/accept"
          data-loading-label="Potvrzuji…">Potvrdit incident</button>`
      : ""
  }
  </article>`;
}

async function pages(url: URL): Promise<Response> {
  const interceptionPage = await interceptionPages(url, sql);
  if (interceptionPage) return interceptionPage;
  if (url.pathname === "/") {
    const podcasts = await sql`
      SELECT podcast.*, count(episode.id)::int AS episode_count,
        count(episode.id) FILTER (WHERE episode.is_present_in_feed)::int AS current_episode_count,
        count(episode.id) FILTER (WHERE NOT episode.is_present_in_feed)::int AS missing_episode_count
      FROM podcasts podcast LEFT JOIN episodes episode ON episode.podcast_id = podcast.id
      GROUP BY podcast.id ORDER BY podcast.created_at DESC
    `;
    const cards = podcasts.map((podcast) =>
      `<article class="card podcast-card">
      <div class="podcast-heading">${podcastArtwork(podcast.name, podcast.imageUrl)}
      <div><h2><a href="/podcasts/${podcast.id}">${escapeHtml(podcast.name)}</a></h2>
      <p class="meta">${escapeHtml(podcast.rssUrl)}</p></div></div>
      <div class="stats"><div class="stat"><strong>${podcast.episodeCount}</strong><span>celkem epizod</span></div>
      <div class="stat"><strong>${podcast.currentEpisodeCount}</strong><span>aktuálně v RSS</span></div>
      <div class="stat">${storageUsageHtml(podcast)}<span>na disku</span></div></div>
      <p class="meta">Naposledy aktualizováno ${
        podcast.lastImportedAt ? new Date(podcast.lastImportedAt).toLocaleString("cs") : "nikdy"
      }</p>
      <div class="row"><button class="secondary" data-action="/api/podcasts/${podcast.id}/import"
        data-loading-label="Aktualizuji…">Aktualizovat RSS</button></div>
    </article>`
    ).join("");
    return html(layout(
      "Podcasty",
      `<section class="hero"><p class="eyebrow">Podcastová knihovna</p><h1>Rozhovory pod kontrolou.</h1>
      <p>Stahujte epizody, přepisujte je na DGX Spark a hledejte v tom, co skutečně zaznělo.</p></section>
      <section class="panel panel-emphasis"><h2>Přidat RSS podcast</h2>
        <p class="muted">Vložte adresu feedu. Existující podcasty můžete později bezpečně aktualizovat.</p>
        <form data-api="/api/podcasts"><input name="rssUrl" type="url" maxlength="2048"
          placeholder="https://example.cz/feed.xml" aria-label="Adresa RSS feedu" required>
          <button type="submit">Přidat podcast</button></form>
      </section><div class="section-heading"><p class="eyebrow">Vaše podcasty</p><h2>Knihovna</h2></div>
      <section class="grid">${
        cards || '<p class="muted">Zatím tu není žádný podcast.</p>'
      }</section>`,
    ));
  }
  const podcastSettingsId = routeId(url.pathname, /^\/podcasts\/([^/]+)\/settings$/);
  if (podcastSettingsId) {
    const podcast = (await sql`
      SELECT podcast.*,
        count(episode.id) FILTER (
          WHERE episode.original_audio_path IS NULL
            AND episode.is_present_in_feed
            AND NOT episode.rag_excluded
            AND NOT EXISTS (
              SELECT 1 FROM jobs download_job
              WHERE download_job.entity_id = episode.id
                AND download_job.type = 'DOWNLOAD_AUDIO'
                AND download_job.status IN ('queued', 'running')
            )
        )::int AS downloadable_episode_count,
        count(episode.id) FILTER (
          WHERE episode.original_audio_path IS NULL
            AND EXISTS (
              SELECT 1 FROM jobs download_job
              WHERE download_job.entity_id = episode.id
                AND download_job.type = 'DOWNLOAD_AUDIO'
                AND download_job.status IN ('queued', 'running')
                AND download_job.payload->>'source' = 'bulk_prefetch'
            )
        )::int AS prefetch_active_count
      FROM podcasts podcast
      LEFT JOIN episodes episode ON episode.podcast_id = podcast.id
      WHERE podcast.id = ${podcastSettingsId}
      GROUP BY podcast.id
    `)[0];
    if (!podcast) throw new NotFoundError("Podcast");
    return html(layout(`Nastavení · ${podcast.name}`, podcastSettingsBody(podcast)));
  }
  const podcastId = routeId(url.pathname, /^\/podcasts\/([^/]+)$/);
  if (podcastId) {
    const selectedFilter = z.enum(episodeFilterValues).optional().parse(
      url.searchParams.get("status") || undefined,
    );
    const podcast = (await sql`
      SELECT podcast.*,
        count(episode.id)::int AS episode_count,
        count(episode.id) FILTER (WHERE episode.is_present_in_feed)::int AS current_episode_count,
        count(episode.id) FILTER (WHERE NOT episode.is_present_in_feed)::int AS missing_episode_count
      FROM podcasts podcast
      LEFT JOIN episodes episode ON episode.podcast_id = podcast.id
      WHERE podcast.id = ${podcastId}
      GROUP BY podcast.id
    `)[0];
    if (!podcast) throw new NotFoundError("Podcast");
    const episodes = selectedFilter
      ? await sql`SELECT episode.*,
          COALESCE(speakers.total, 0)::int AS speaker_count,
          COALESCE(speakers.verified, 0)::int AS verified_speaker_count,
          processed.transcription_provider, processed.transcription_model,
          processed.diarization_model, processed.transcript_alignment_mode
          FROM episodes episode
          LEFT JOIN LATERAL (
            SELECT run.transcription_provider, run.transcription_model, run.diarization_model, run.transcript_alignment_mode
            FROM processing_runs run WHERE run.episode_id = episode.id AND run.status = 'completed'
            ORDER BY (run.id = episode.active_processing_run_id) DESC NULLS LAST, run.started_at DESC
            LIMIT 1
          ) processed ON true
          LEFT JOIN LATERAL (
            SELECT count(*) FILTER (
                WHERE cluster.identity_status <> 'ignored'
              )::int AS total,
              count(*) FILTER (WHERE cluster.identity_status = 'verified')::int AS verified
            FROM speaker_clusters cluster
            WHERE cluster.episode_id = episode.id
              AND cluster.processing_run_id = episode.active_processing_run_id
          ) speakers ON true
          WHERE episode.podcast_id = ${podcastId}
          AND ((${selectedFilter === "skipped"} AND episode.speaker_review_skipped)
            OR (${selectedFilter !== "skipped"} AND NOT episode.speaker_review_skipped
              AND episode.processing_status::text = ANY(${[
        ...episodeStatusesForFilter(selectedFilter),
      ]})))
          ORDER BY published_at DESC NULLS LAST`
      : await sql`SELECT episode.*,
          COALESCE(speakers.total, 0)::int AS speaker_count,
          COALESCE(speakers.verified, 0)::int AS verified_speaker_count,
          processed.transcription_provider, processed.transcription_model,
          processed.diarization_model, processed.transcript_alignment_mode
          FROM episodes episode
          LEFT JOIN LATERAL (
            SELECT run.transcription_provider, run.transcription_model, run.diarization_model, run.transcript_alignment_mode
            FROM processing_runs run WHERE run.episode_id = episode.id AND run.status = 'completed'
            ORDER BY (run.id = episode.active_processing_run_id) DESC NULLS LAST, run.started_at DESC
            LIMIT 1
          ) processed ON true
          LEFT JOIN LATERAL (
            SELECT count(*) FILTER (
                WHERE cluster.identity_status <> 'ignored'
              )::int AS total,
              count(*) FILTER (WHERE cluster.identity_status = 'verified')::int AS verified
            FROM speaker_clusters cluster
            WHERE cluster.episode_id = episode.id
              AND cluster.processing_run_id = episode.active_processing_run_id
          ) speakers ON true
          WHERE episode.podcast_id = ${podcastId}
          ORDER BY published_at DESC NULLS LAST`;
    const list = episodes.map((episode) => {
      const canProcess = episode.isPresentInFeed !== false || Boolean(episode.originalAudioPath);
      const action = episodeActionAppearance(
        episode.processingStatus,
        Boolean(episode.originalAudioPath),
      );
      const confirmation = episodeActionConfirmation(episode.processingStatus);
      return `<article class="episode-card">
      <div class="row spread"><div class="row">${
        episodeStatusBadge(episode.processingStatus, episode.speakerReviewSkipped)
      }
        ${
        episode.speakerReviewSkipped
          ? ""
          : episodeSpeakerAssignmentBadge(episode.speakerCount, episode.verifiedSpeakerCount)
      }
        ${
        episode.isPresentInFeed === false ? '<span class="badge badge-neutral">Mimo RSS</span>' : ""
      }</div><span class="meta">${
        episode.publishedAt ? new Date(episode.publishedAt).toLocaleDateString("cs") : "Bez data"
      }</span></div>
      <h2><a href="/episodes/${episode.id}">${escapeHtml(episode.title)}</a></h2>
      <p class="episode-description">${
        escapeHtml(htmlToPlainText(episode.description) ?? "Popis není k dispozici.")
      }</p>
      <p class="meta">${
        episode.transcriptionModel
          ? `Přepis: ${escapeHtml(transcriptLabel(episode))} · Diarizace: ${
            escapeHtml(episode.diarizationModel ?? "bez diarizace")
          }`
          : "Přepis zatím nebyl vytvořen."
      }</p>
      ${
        episode.transcriptSelectionPending
          ? `<a class="button secondary" href="/episodes/${episode.id}">Vybrat přepis a přiřadit hlasy</a>`
          : ""
      }
      ${feedMissingWarning(episode)}
      ${
        episode.processingError
          ? `<div class="alert alert-danger">${escapeHtml(episode.processingError)}</div>`
          : ""
      }
      <button${action.className ? ` class="${action.className}"` : ""}
        data-action="/api/episodes/${episode.id}/process" data-loading-label="Zařazuji…"
        ${episode.transcriptionModel ? `data-body='{"mode":"full"}'` : ""}
        ${confirmation ? `data-confirm="${escapeHtml(confirmation)}"` : ""}
        ${canProcess ? "" : "disabled"}>${
        episode.transcriptionModel ? "Přegenerovat lokálně" : action.label
      }</button>
      ${
        canProcess
          ? ""
          : '<span class="meta">Nelze stáhnout: epizoda už není v RSS a audio nebylo uloženo.</span>'
      }
    </article>`;
    }).join("");
    return html(layout(
      String(podcast.name),
      `<a class="back-link" href="/">← Všechny podcasty</a>
      <section class="page-header"><div class="row spread">
      <div class="podcast-detail-heading">${podcastArtwork(podcast.name, podcast.imageUrl, true)}
      <div><p class="eyebrow">Detail podcastu</p>
      <h1>${escapeHtml(podcast.name)}</h1><p>${
        escapeHtml(htmlToPlainText(podcast.description))
      }</p></div></div>
      ${podcastSettingsLink(podcast.id)}</div>
      <div class="stats"><div class="stat"><strong>${podcast.episodeCount}</strong><span>epizod celkem</span></div>
      <div class="stat"><strong>${podcast.currentEpisodeCount}</strong><span>v aktuálním RSS</span></div>
      <div class="stat"><strong>${podcast.missingEpisodeCount}</strong><span>mimo RSS</span></div>
      <div class="stat">${storageUsageHtml(podcast)}<span>na disku</span></div></div>
      <p class="meta">Poslední aktualizace: ${
        podcast.lastImportedAt ? new Date(podcast.lastImportedAt).toLocaleString("cs") : "nikdy"
      }</p></section>
      <div class="section-heading"><p class="eyebrow">Archiv</p><h2>Epizody</h2></div>
      <form class="episode-filter" method="get">
        <label for="episode-status-filter">Filtrovat podle stavu</label>
        <select id="episode-status-filter" name="status">
          <option value="">Všechny stavy</option>
          ${
        episodeFilterValues.map((filter) =>
          `<option value="${filter}"${selectedFilter === filter ? " selected" : ""}>${
            episodeFilterLabels[filter]
          }</option>`
        ).join("")
      }
        </select>
        <button type="submit">Filtrovat</button>
        ${
        selectedFilter
          ? `<a class="button secondary" href="/podcasts/${podcast.id}">Zrušit filtr</a>
            <span class="filter-summary">Nalezeno: ${episodes.length}</span>`
          : ""
      }
      </form>
      <section class="episode-list">${
        list || (selectedFilter
          ? '<p class="muted">Tomuto filtru neodpovídá žádná epizoda.</p>'
          : '<p class="muted">Podcast zatím nemá epizody.</p>')
      }</section>`,
    ));
  }
  const comparisonEpisodeId = routeId(url.pathname, /^\/episodes\/([^/]+)\/transcripts$/);
  if (comparisonEpisodeId) {
    const episode = (await sql`SELECT * FROM episodes WHERE id = ${comparisonEpisodeId}`)[0];
    if (!episode) throw new NotFoundError("Epizoda");
    const runs = await listTranscripts(sql, comparisonEpisodeId);
    const leftId = url.searchParams.has("left")
      ? uuidSchema.parse(url.searchParams.get("left"))
      : runs[0]?.id;
    const rightId = url.searchParams.has("right")
      ? uuidSchema.parse(url.searchParams.get("right"))
      : runs.find((run) => run.id !== leftId)?.id;
    const left = runs.find((run) => run.id === leftId);
    const right = runs.find((run) => run.id === rightId);
    if (!left || (rightId && !right)) throw new NotFoundError("Přepis této epizody");
    const rows = await sql`SELECT utterance.*, cluster.local_label
      FROM utterances utterance JOIN speaker_clusters cluster ON cluster.id = utterance.speaker_cluster_id
      WHERE utterance.episode_id = ${comparisonEpisodeId}
        AND utterance.processing_run_id IN (${left.id}, ${right?.id ?? left.id})
      ORDER BY utterance.sequence_number`;
    const options = (selected: unknown) =>
      runs.map((run) =>
        `<option value="${run.id}"${run.id === selected ? " selected" : ""}>${
          escapeHtml(transcriptLabel(run))
        } · ${Number(run.speakerCount)} hlasů · ${
          escapeHtml(new Date(String(run.startedAt)).toLocaleString("cs"))
        }</option>`
      ).join("");
    return html(
      layout(
        "Porovnání přepisů",
        `<a class="back-link" href="/episodes/${comparisonEpisodeId}">← Zpět na epizodu a přiřazení hlasů</a>
      <h1>Porovnání přepisů</h1><p>${escapeHtml(episode.title)}</p>
      <p>Úseky jsou zarovnané po 30 sekundách podle začátku promluvy. Zvýraznění označuje rozdílný text nebo členění. Označení hlasů platí vždy jen uvnitř daného přepisu.</p>
      <form method="GET" class="transcript-comparison-columns"><label>Levý přepis<select name="left">${
          options(left.id)
        }</select></label>
        <label>Pravý přepis<select name="right">${
          options(right?.id ?? left.id)
        }</select></label><button type="submit">Porovnat</button></form>
      ${
          episode.originalAudioPath
            ? `<audio controls preload="metadata" src="/api/episodes/${comparisonEpisodeId}/audio"></audio>`
            : ""
        }
      <div class="transcript-comparison-columns"><div><h2>${
          escapeHtml(transcriptLabel(left))
        }</h2><p>${Number(left.speakerCount)} mluvčích</p>${
          transcriptSelectionButton(comparisonEpisodeId, left, episode)
        }</div>
        <div>${
          right
            ? `<h2>${escapeHtml(transcriptLabel(right))}</h2><p>${
              Number(right.speakerCount)
            } mluvčích</p>${transcriptSelectionButton(comparisonEpisodeId, right, episode)}`
            : "<p>Další přepis zatím není k dispozici.</p>"
        }</div></div>
      ${
          transcriptComparison(
            rows.filter((row) => row.processingRunId === left.id),
            rows.filter((row) => row.processingRunId === right?.id),
          )
        }`,
      ),
    );
  }
  const episodeId = routeId(url.pathname, /^\/episodes\/([^/]+)$/);
  if (episodeId) {
    const episode = (await sql`
      SELECT episode.*, podcast.name AS podcast_name
      FROM episodes episode JOIN podcasts podcast ON podcast.id = episode.podcast_id
      WHERE episode.id = ${episodeId}
    `)[0];
    if (!episode) throw new NotFoundError("Epizoda");
    const [
      people,
      clusters,
      utterances,
      chunks,
      artifacts,
      nextSpeakerEpisodeId,
      transcriptRuns,
    ] = await Promise.all([
      sql`SELECT person.*, association.role AS podcast_role
        FROM podcast_persons association
        JOIN persons person ON person.id = association.person_id
        WHERE association.podcast_id = ${episode.podcastId}
        ORDER BY association.role, person.display_name`,
      sql`SELECT cluster.*, person.display_name, association.role AS podcast_role,
          EXISTS (SELECT 1 FROM speaker_embeddings WHERE speaker_cluster_id = cluster.id) AS has_voice_embedding
        FROM speaker_clusters cluster
        LEFT JOIN persons person ON person.id = cluster.assigned_person_id
        LEFT JOIN podcast_persons association
          ON association.person_id = person.id
          AND association.podcast_id = ${episode.podcastId}
        WHERE cluster.episode_id = ${episodeId}
          AND cluster.processing_run_id = ${episode.activeProcessingRunId}
        ORDER BY cluster.local_label`,
      sql`SELECT utterance.*, cluster.local_label, person.display_name,
          cluster_person.display_name AS cluster_display_name
        FROM utterances utterance
        JOIN speaker_clusters cluster ON cluster.id = utterance.speaker_cluster_id
        LEFT JOIN persons person ON person.id = utterance.person_id
        LEFT JOIN persons cluster_person ON cluster_person.id = cluster.assigned_person_id
        WHERE utterance.episode_id = ${episodeId}
          AND utterance.processing_run_id = ${episode.activeProcessingRunId}
        ORDER BY utterance.sequence_number`,
      sql`SELECT * FROM content_chunks WHERE episode_id = ${episodeId}
        AND processing_run_id = ${episode.activeProcessingRunId} ORDER BY start_seconds`,
      sql`SELECT * FROM processing_artifacts WHERE episode_id = ${episodeId}
        ORDER BY created_at DESC`,
      nextSpeakerReviewEpisode(sql, episode.podcastId, episodeId),
      listTranscripts(sql, episodeId),
    ]);
    const personOptions = (
      availablePeople: Record<string, unknown>[],
      selectedPersonId?: unknown,
    ) =>
      availablePeople.map((person) =>
        `<option value="${person.id}"${
          String(selectedPersonId ?? "") === String(person.id) ? " selected" : ""
        }>${escapeHtml(person.displayName)}</option>`
      ).join("");
    const moderators = people.filter((person) => person.podcastRole === "moderator");
    const guests = people.filter((person) => person.podcastRole === "guest");
    const episodeAction = episodeActionAppearance(
      episode.processingStatus,
      Boolean(episode.originalAudioPath),
    );
    const episodeConfirmation = episodeActionConfirmation(episode.processingStatus);
    const identifiableClusters = clusters.filter((cluster) => cluster.identityStatus !== "ignored");
    const assignedSpeakerCount = identifiableClusters.filter((cluster) =>
      cluster.assignedPersonId
    ).length;
    const suggestedSpeakerCount = clusters.filter((cluster) =>
      cluster.identityStatus === "suggested"
    ).length;
    const speakerCards = clusters.map((cluster) => {
      const verified = isVerifiedSpeakerAssignment(
        cluster.assignedPersonId,
        cluster.identityStatus,
      );
      const ignored = cluster.identityStatus === "ignored";
      const compact = isCompactSpeakerCard(cluster.assignedPersonId, cluster.identityStatus);
      const assignmentType = cluster.assignedPersonId
        ? (cluster.podcastRole === "moderator" ? "moderator" : "guest")
        : moderators.length > 0
        ? "moderator"
        : guests.length > 0
        ? "guest"
        : "newGuest";
      const automaticIdentityBadge = cluster.identitySource === "automatic_voice_match"
        ? `<span class="badge badge-info">Automaticky přiřazený moderátor · ${
          Math.round(Number(cluster.identityConfidence ?? 0) * 100)
        } %</span>`
        : cluster.identitySource === "llm_episode_metadata"
        ? `<span class="badge badge-info">Host z popisku · ${
          Math.round(Number(cluster.identityConfidence ?? 0) * 100)
        } %</span>`
        : ignored
        ? '<span class="badge badge-neutral">Ignorovaný hlas</span>'
        : "";
      const newPersonPanel = (type: "newModerator" | "newGuest", label: string) =>
        `<div class="assignment-panel" data-assignment-panel="${type}"${
          assignmentType === type ? "" : " hidden"
        }>
          <label class="form-field"><span>Jméno ${label}</span>
            <input name="displayName" maxlength="200" autocomplete="name"
              placeholder="Jméno a příjmení" required${
          assignmentType === type ? "" : " disabled"
        }></label>
          <label class="form-field"><span>Poznámka</span>
            <textarea name="description" maxlength="4000"
              placeholder="Volitelná poznámka"${
          assignmentType === type ? "" : " disabled"
        }></textarea></label>
        </div>`;
      const sampleButton = cluster.representativeStartSeconds !== null
        ? `<button type="button" class="secondary" data-seek="${cluster.representativeStartSeconds}">▶ Přehrát ukázku (${
          formatTimestamp(Number(cluster.representativeStartSeconds))
        })</button>`
        : "";
      const rejectButton = cluster.identityStatus === "suggested"
        ? `<button type="button" class="secondary"
            data-action="/api/speaker-clusters/${cluster.id}/reject">Odmítnout návrh</button>`
        : "";
      const ignoreButton = `<button type="button" class="secondary"
        data-action="/api/speaker-clusters/${cluster.id}/ignore"
        data-confirm="Ignorovaný hlas se nebude nabízet k identifikaci. Případné přiřazení hlasu a jeho ověřená hlasová reference se odstraní."
        data-confirm-label="Ano, ignorovat">Ignorovat hlas</button>`;
      return `<article class="card speaker${compact ? " speaker-compact" : ""}"
        data-speaker-card>
      <div class="speaker-summary">
        <div><h3>${escapeHtml(cluster.localLabel)}</h3>
          <p>${Number(cluster.totalSpeechSeconds).toFixed(1)} s · ${cluster.segmentCount} segmentů ·
            identita: <strong>${
        escapeHtml(ignored ? "ignorovaná" : cluster.displayName ?? "nepřiřazená")
      }</strong></p>
          ${automaticIdentityBadge}</div>
        ${
        ignored
          ? `<button type="button" class="secondary"
              data-action="/api/speaker-clusters/${cluster.id}/restore">Obnovit hlas</button>`
          : verified
          ? '<button type="button" class="secondary" data-speaker-edit>Editovat</button>'
          : ""
      }
      </div>
      <div data-speaker-editor${compact ? " hidden" : ""}>
        ${
        cluster.identityStatus === "suggested"
          ? `<div class="alert alert-info"><strong>Automatický návrh – čeká na potvrzení.</strong>
            Jistota: ${Math.round(Number(cluster.identityConfidence ?? 0) * 100)} %.</div>`
          : ""
      }
      <form class="speaker-assignment-form" data-speaker-assignment
        data-api="/api/speaker-clusters/${cluster.id}/assign">
        <fieldset class="assignment-kind"><legend>Koho hlas reprezentuje?</legend>
          <div class="segmented-control segmented-control-four">
            <label><input type="radio" name="assignmentType" value="moderator"${
        assignmentType === "moderator" ? " checked" : ""
      }${moderators.length === 0 ? " disabled" : ""}><span>Moderátor</span></label>
            <label><input type="radio" name="assignmentType" value="guest"${
        assignmentType === "guest" ? " checked" : ""
      }${guests.length === 0 ? " disabled" : ""}><span>Host</span></label>
            <label><input type="radio" name="assignmentType" value="newModerator">
              <span>Nový moderátor</span></label>
            <label><input type="radio" name="assignmentType" value="newGuest"${
        assignmentType === "newGuest" ? " checked" : ""
      }><span>Nový host</span></label>
          </div>
        </fieldset>
        <div class="assignment-panel" data-assignment-panel="moderator"${
        assignmentType === "moderator" ? "" : " hidden"
      }>
          <label class="form-field"><span>Existující moderátor</span>
            <select name="personId" data-filter-dropdown
              data-filter-label="Existující moderátor"
              data-filter-placeholder="Hledat moderátora…" required${
        assignmentType === "moderator" ? "" : " disabled"
      }><option value="">Vyberte moderátora…</option>${
        personOptions(moderators, cluster.assignedPersonId)
      }</select></label>
        </div>
        <div class="assignment-panel" data-assignment-panel="guest"${
        assignmentType === "guest" ? "" : " hidden"
      }>
          <label class="form-field"><span>Existující host</span>
            <select name="personId" data-filter-dropdown
              data-filter-label="Existující host"
              data-filter-placeholder="Hledat hosta…" required${
        assignmentType === "guest" ? "" : " disabled"
      }><option value="">Vyberte hosta…</option>${
        personOptions(guests, cluster.assignedPersonId)
      }</select></label>
        </div>
        ${newPersonPanel("newModerator", "nového moderátora")}
        ${newPersonPanel("newGuest", "nového hosta")}
        <div class="checkbox-row">
          <label class="checkbox-field"><input type="checkbox" name="verified" checked>
            <span>Ověřeno</span></label>
          <label class="checkbox-field"><input type="checkbox" name="createReferenceEmbeddings"${
        cluster.hasVoiceEmbedding ? " checked" : " disabled"
      }>
            <span>${
        cluster.hasVoiceEmbedding
          ? "Uložit hlasovou referenci"
          : "Hlasová reference není pro tuto variantu dostupná"
      }</span></label>
          <label class="checkbox-field"><input type="checkbox" name="overwrite"${
        cluster.assignedPersonId ? " checked" : ""
      }>
            <span>Přepsat existující přiřazení</span></label>
        </div>
        <div class="speaker-actions">${sampleButton}
          <button type="submit">${
        cluster.identityStatus === "suggested" ? "Potvrdit návrh" : "Potvrdit"
      }</button>
          ${rejectButton}
          ${ignoreButton}
        </div>
      </form>
      </div>
    </article>`;
    }).join("");
    return html(
      layout(
        String(episode.title),
        `<a class="back-link" href="/podcasts/${episode.podcastId}">← ${
          escapeHtml(episode.podcastName)
        }</a>
      <section class="page-header"><p class="eyebrow">Epizoda</p>
      <div class="row"><h1>${escapeHtml(episode.title)}</h1>${
          episodeStatusBadge(episode.processingStatus, episode.speakerReviewSkipped)
        }${
          episode.isPresentInFeed === false
            ? '<span class="badge badge-neutral">Mimo RSS</span>'
            : ""
        }</div>
      <p class="episode-description-full">${
          escapeHtml(htmlToPlainText(episode.description) ?? "Popis není k dispozici.")
        }</p>
      <p class="meta">Vydáno: ${escapeHtml(formatEpisodePublishedDate(episode.publishedAt))}</p>
      ${feedMissingWarning(episode)}
      ${
          episode.processingError
            ? `<div class="alert alert-danger">${escapeHtml(episode.processingError)}</div>`
            : ""
        }
      <div class="row"><button${
          episodeAction.className ? ` class="${episodeAction.className}"` : ""
        }
        data-action="/api/episodes/${episodeId}/process" data-loading-label="Zařazuji…"
        ${transcriptRuns.length ? `data-body='{"mode":"full"}'` : ""}
        ${episodeConfirmation ? `data-confirm="${escapeHtml(episodeConfirmation)}"` : ""}
        ${
          episode.ragExcluded || (episode.isPresentInFeed === false && !episode.originalAudioPath)
            ? "disabled"
            : ""
        }>${transcriptRuns.length ? "Přegenerovat lokálně" : episodeAction.label}</button>
      ${episodeRagExclusionControl(episodeId, episode.ragExcluded)}</div>
      </section>
      ${
          episode.originalAudioPath
            ? `<audio controls preload="metadata" src="/api/episodes/${episodeId}/audio"></audio>`
            : "<p>Audio zatím není stažené.</p>"
        }
      ${transcriptVariantsSection(episode, transcriptRuns, Boolean(config.ELEVENLABS_API_KEY))}
      <section><div class="row spread"><h2>Mluvčí</h2>
      ${episodeSpeakerReviewControl(episodeId, episode.speakerReviewSkipped)}</div>
      ${
          !episode.transcriptSelectionPending && identifiableClusters.length > 0 &&
            assignedSpeakerCount === 0 && clusters.some((cluster) => cluster.hasVoiceEmbedding)
            ? `<div class="card"><p><strong>Automatické přiřazení nenašlo jistou shodu.</strong>
            Hlasy můžete znovu porovnat s ověřenými referencemi stálých moderátorů podcastu.
            Výsledky se pouze navrhnou a musíte je ručně potvrdit.</p>
            <button data-action="/api/episodes/${episodeId}/suggest-speakers"
              data-loading-label="Porovnávám hlasy…">Navrhnout stálé moderátory</button></div>`
            : suggestedSpeakerCount > 0
            ? `<div class="alert alert-info">Čeká na ruční potvrzení: ${suggestedSpeakerCount}.</div>`
            : ""
        }
      ${
          episode.transcriptSelectionPending
            ? "<p>Nejdříve vyberte variantu přepisu výše.</p>"
            : speakerCards || "<p>Čeká na diarizaci.</p>"
        }
      ${nextSpeakerAssignmentEpisodeLink(nextSpeakerEpisodeId)}</section>
      <section><h2>Přepis</h2>${
          (episode.transcriptSelectionPending
            ? "<p>Přepisy jsou dostupné v porovnání variant výše.</p>"
            : utterances.map((utterance) => transcriptLine(utterance, people)).join("")) ||
          "<p>Přepis zatím není dostupný.</p>"
        }</section>
      <section><h2>Obsahové chunky</h2>${
          chunks.map((chunk) =>
            `<article class="card"><button class="timestamp" data-seek="${
              chunk.playbackStartSeconds ?? chunk.startSeconds
            }">${
              formatTimestamp(Number(chunk.playbackStartSeconds ?? chunk.startSeconds))
            }</button><p>${escapeHtml(chunk.text)}</p></article>`
          ).join("") || "<p>Indexace zatím neproběhla.</p>"
        }</section>
      <section><h2>Artefakty</h2><table><tr><th>Typ</th><th>Velikost</th><th>Model</th></tr>${
          artifacts.map((a) =>
            `<tr><td>${escapeHtml(a.artifactType)}</td><td>${
              escapeHtml(a.byteSize ?? "—")
            }</td><td>${escapeHtml(a.modelName ?? "—")}</td></tr>`
          ).join("")
        }</table></section>`,
      ),
    );
  }
  if (url.pathname === "/search") {
    const podcasts = await sql`
      SELECT podcast.id, podcast.name
      FROM podcasts podcast
      WHERE EXISTS (
        SELECT 1
        FROM episodes episode
        JOIN content_chunks chunk
          ON chunk.episode_id = episode.id
          AND chunk.processing_run_id = episode.active_processing_run_id
        WHERE episode.podcast_id = podcast.id AND NOT episode.rag_excluded
      )
      ORDER BY podcast.name
    `;
    const podcastOptions = podcasts.map((podcast) =>
      `<option value="${podcast.id}">${escapeHtml(podcast.name)}</option>`
    ).join("");
    return html(layout(
      "Vyhledávání",
      `<section class="page-header"><p class="eyebrow">Práce se zdroji</p>
        <h1>Ptejte se nad archivem.</h1>
        <p>Vyberte kontext a položte otázku. Aplikace dohledá relevantní výroky a sestaví
        odpověď rozdělenou do tematických částí s odkazy na konkrétní epizody.</p></section>
      <section class="card ask-workspace">
      <form class="ask-form" data-api="/api/ask" data-render="#answer" data-kind="ask"
        data-search-filters>
        <div class="ask-filter-grid">
        <label>Podcast <select name="podcastId" data-search-podcast required>
          <option value="">vyberte podcast…</option>${podcastOptions}</select></label>
        <label>Epizoda <select name="episodeId" data-search-episode disabled>
          <option value="">všechny epizody</option></select></label>
        <label>Mluvčí <select name="personId" data-search-person data-filter-dropdown
          data-filter-label="Mluvčí" data-filter-placeholder="Hledat hosta nebo moderátora…"
          disabled>
          <option value="">všichni mluvčí</option></select></label>
        <label>Model odpovědi <select name="answerProvider" required>
          <option value="thinking-cap"${
        thinkingCapProvider
          ? (defaultAnswerProviderId === "thinking-cap" ? " selected" : "")
          : " disabled"
      }>ThinkingCap · lokální</option>
          ${
        openAiAnswerModels.map((model) =>
          `<option value="${model.id}"${answerProviders.get(model.id) ? "" : " disabled"}${
            model.id === defaultAnswerProviderId ? " selected" : ""
          }>${model.label} · OpenAI</option>`
        ).join("")
      }
        </select></label></div>
        <label class="ask-question">Otázka
          <textarea name="question" maxlength="1000"
            placeholder="Například: Jak Michal Půr hodnotí Deník N a jak se jeho názor v čase měnil?"
            required></textarea></label>
        <div class="ask-submit-row"><p class="meta">Při volbě modelu OpenAI se otázka a vybrané
          úryvky odešlou do OpenAI API pro rozšíření hledání a sestavení odpovědi.</p>
          <button type="submit">Analyzovat zdroje</button></div></form>
        <div id="answer" class="results"></div></section>`,
    ));
  }
  if (url.pathname === "/jobs") {
    const rows = await recentJobs();
    return html(
      layout(
        "Úlohy",
        `<section class="page-header"><p class="eyebrow">Zpracování</p><h1>Úlohy</h1>
        <p>Zobrazeny jsou úlohy vytvořené za posledních 24 hodin. Aktivní doba nezahrnuje čekání
        ve frontě ani čekání na volný ML model a aktualizuje se každou sekundu. Stahování a
        zpracování mají oddělené pracovní sloty, takže mohou běžet souběžně.</p></section>
        <div class="table-scroll"><table data-live-jobs><thead><tr><th>Epizoda / podcast</th>
        <th>Fronta</th><th>Typ</th><th>Stav</th><th>Průběh</th><th>Doba</th><th>Pokus</th><th>Chyba</th></tr></thead>
        <tbody>${rows.map((job) => jobRow(job)).join("")}</tbody></table></div>`,
      ),
    );
  }
  if (url.pathname === "/system-incidents") {
    const rows = await incidents.list();
    const openCount = rows.filter((incident) => incident.status === "open").length;
    return html(layout(
      "Systémová upozornění",
      `<section class="page-header"><p class="eyebrow">Provoz</p>
        <div class="row spread"><div><h1>Systémová upozornění</h1>
        <p>Historie automatických kontrol Audio ML. Stejný nepotvrzený problém odešle
        nejvýše jednu Pushover zprávu za tři hodiny.</p></div>
        <button class="secondary" data-action="/api/system-incidents/test-notification"
          data-loading-label="Odesílám…" data-success="alert">Otestovat notifikaci</button></div>
        <div class="stats"><div class="stat"><strong>${openCount}</strong>
          <span>nepotvrzených incidentů</span></div><div class="stat"><strong>${rows.length}</strong>
          <span>záznamů v historii</span></div></div></section>
        <section class="incident-list">${
        rows.map((incident) => incidentCard(incident as unknown as Record<string, unknown>)).join(
          "",
        ) ||
        '<p class="muted">Zatím nebyl zaznamenán žádný systémový incident.</p>'
      }</section>`,
    ));
  }
  throw new NotFoundError("Stránka");
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname.startsWith("/static/")) {
      const name = url.pathname.slice("/static/".length);
      if (!/^[a-z0-9.-]+$/i.test(name)) throw new NotFoundError("Soubor");
      const path = join(staticRoot, name);
      const content = await Deno.readFile(path);
      const type = name.endsWith(".svg")
        ? "image/svg+xml"
        : name.endsWith(".css")
        ? "text/css"
        : "text/javascript";
      return new Response(content, {
        headers: {
          "content-type": `${type}; charset=utf-8`,
          "cache-control": "no-cache",
        },
      });
    }
    const apiResponse = await api(request, url);
    if (apiResponse) return apiResponse;
    return await pages(url);
  } catch (error) {
    const domain = error instanceof DomainError ? error : null;
    const status = domain?.status ?? (error instanceof ZodError ? 400 : 500);
    const message = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : error instanceof Error
      ? error.message
      : "Neznámá chyba.";
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      return json({ code: domain?.code ?? "INTERNAL_ERROR", message }, status);
    }
    return html(layout("Chyba", `<h1>Chyba</h1><p>${escapeHtml(message)}</p>`), status);
  }
}

const port = Number(new URL(config.APP_BASE_URL).port || 8000);
Deno.serve(
  { port, onListen: ({ port }) => console.log(`Web běží na http://localhost:${port}`) },
  handler,
);
