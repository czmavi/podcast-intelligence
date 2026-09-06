import { createDatabase } from "../../packages/database/client.ts";
import { JobRepository } from "../../packages/database/repositories/jobs.ts";
import { scheduleNextAutoProcessEpisode } from "../../packages/database/episode-processing.ts";
import { scheduleDuePodcastRefresh } from "../../packages/database/podcast-refresh.ts";
import { refreshEpisodeStorageUsage } from "../../packages/database/storage-usage.ts";
import {
  downloadJobTypes,
  type Job,
  type JobProgressReporter,
  type JobType,
  processingJobTypes,
} from "../../packages/domain/job-types.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import { loadConfig } from "../../packages/shared/config.ts";
import { log } from "../../packages/shared/logging.ts";
import { createHandlers } from "./jobs/pipeline.ts";
import { nextPipelineStep } from "./services/pipeline-continuation.ts";
import { transcriptAlignmentModeSchema } from "../../packages/domain/schemas.ts";

const config = loadConfig();
const sql = createDatabase(config);
const jobs = new JobRepository(sql);
const handlers = createHandlers(sql, config);
const workerId = `${Deno.hostname()}-${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;
const shutdown = new AbortController();

function wait(milliseconds: number): Promise<void> {
  if (shutdown.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    shutdown.signal.addEventListener("abort", done, { once: true });
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    stopping = true;
    shutdown.abort();
    log("info", "Worker ukončuje příjem nových úloh.", { workerId, signal });
  });
}

log("info", "Worker spuštěn.", {
  workerId,
  processingConcurrency: config.WORKER_CONCURRENCY,
  downloadConcurrency: config.DOWNLOAD_WORKER_CONCURRENCY,
  autoProcessIntervalMs: config.AUTO_PROCESS_INTERVAL_MS,
});

async function enqueueNext(job: Job): Promise<void> {
  const step = nextPipelineStep(job);
  if (!step) return;
  let payload: Record<string, unknown> = {};
  if (step.type === "PROCESS_AUDIO_ML") {
    const rows = await sql`
      SELECT podcast.transcript_alignment_mode
      FROM episodes episode
      JOIN podcasts podcast ON podcast.id = episode.podcast_id
      WHERE episode.id = ${job.entityId}
    `;
    if (!rows[0]) throw new Error("Epizoda nebyla nalezena.");
    payload = {
      transcriptAlignmentMode: transcriptAlignmentModeSchema.parse(
        rows[0].transcriptAlignmentMode,
      ),
    };
  }
  await jobs.enqueue(step.type, "episode", job.entityId, payload, 0, config.MAX_JOB_ATTEMPTS);
  await sql`UPDATE episodes SET processing_status = ${step.status}, updated_at = now()
    WHERE id = ${job.entityId}`;
}

async function runWorkerSlot(
  queue: "download" | "processing",
  slot: number,
  allowedTypes: readonly JobType[],
): Promise<void> {
  const slotWorkerId = `${workerId}-${queue}-${slot}`;
  while (!stopping) {
    const job = await jobs.claim(slotWorkerId, config.JOB_LOCK_TIMEOUT_SECONDS, allowedTypes);
    if (!job) {
      await wait(config.JOB_POLL_INTERVAL_MS);
      continue;
    }
    const started = performance.now();
    const heartbeat = setInterval(
      () => jobs.heartbeat(job.id, slotWorkerId).catch(() => undefined),
      Math.min(30_000, config.JOB_LOCK_TIMEOUT_SECONDS * 250),
    );
    try {
      const handler = handlers[job.type as keyof typeof handlers] as
        | ((claimedJob: Job, reportProgress: JobProgressReporter) => Promise<unknown>)
        | undefined;
      if (!handler) throw new DomainError(`Job ${job.type} není implementovaný.`, "UNKNOWN_JOB");
      const reportProgress: JobProgressReporter = (progress) =>
        jobs.updateProgress(job.id, slotWorkerId, progress);
      const result = await handler(job, reportProgress);
      await enqueueNext(job);
      await jobs.complete(job.id, slotWorkerId, result);
      log("info", "Job dokončen.", {
        jobId: job.id,
        jobType: job.type,
        episodeId: job.entityId,
        workerId: slotWorkerId,
        queue,
        durationMs: Math.round(performance.now() - started),
        attempt: job.attempts,
      });
    } catch (error) {
      const domain = error instanceof DomainError ? error : null;
      const message = error instanceof Error ? error.message : String(error);
      await jobs.fail(job, slotWorkerId, message, domain?.retryable ?? true);
      if (job.entityType === "episode" && job.payload.nonBlocking !== true) {
        await sql`UPDATE episodes SET processing_status = 'failed',
          processing_error = ${message.slice(0, 4000)}, updated_at = now()
          WHERE id = ${job.entityId}`;
      }
      if (job.type === "PROCESS_AUDIO_ML" && job.payload.transcriptProvider !== "elevenlabs") {
        try {
          const diagnosticJobId = await jobs.enqueue(
            "CHECK_AUDIO_ML_HEALTH",
            "system",
            job.entityId,
            {
              failedJobId: job.id,
              failedAttempt: job.attempts,
              failureMessage: message,
            },
            100,
            1,
          );
          log("info", "Po selhání Audio ML byla zařazena diagnostika.", {
            failedJobId: job.id,
            diagnosticJobId,
            episodeId: job.entityId,
          });
        } catch (diagnosticError) {
          log("error", "Zařazení diagnostiky Audio ML selhalo.", {
            failedJobId: job.id,
            episodeId: job.entityId,
            error: diagnosticError instanceof Error
              ? diagnosticError.message
              : String(diagnosticError),
          });
        }
      }
      log("error", "Job selhal.", {
        jobId: job.id,
        jobType: job.type as JobType,
        episodeId: job.entityId,
        workerId: slotWorkerId,
        queue,
        durationMs: Math.round(performance.now() - started),
        attempt: job.attempts,
        error: message,
      });
    } finally {
      clearInterval(heartbeat);
      if (job.entityType === "episode") {
        try {
          const usage = await refreshEpisodeStorageUsage(sql, config.STORAGE_ROOT, job.entityId);
          if (usage) {
            log("info", "Využití úložiště podcastu bylo aktualizováno.", {
              episodeId: job.entityId,
              episodeBytes: usage.episode.totalBytes,
              podcastBytes: usage.podcast.totalBytes,
            });
          }
        } catch (error) {
          log("warn", "Aktualizace využití úložiště selhala.", {
            episodeId: job.entityId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

async function runAutomationSchedulers(): Promise<void> {
  while (!stopping) {
    try {
      const refresh = await scheduleDuePodcastRefresh(sql, config.MAX_JOB_ATTEMPTS);
      if (refresh) {
        log("info", "Denní automatika zařadila aktualizaci RSS.", { ...refresh });
      }
      const scheduled = await scheduleNextAutoProcessEpisode(sql, config.MAX_JOB_ATTEMPTS);
      if (scheduled) {
        log("info", "Autopilot zařadil další epizodu.", { ...scheduled });
      }
    } catch (error) {
      log("error", "Kontrola automatizací selhala.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await wait(config.AUTO_PROCESS_INTERVAL_MS);
  }
}

await Promise.all(
  [
    ...Array.from(
      { length: config.DOWNLOAD_WORKER_CONCURRENCY },
      (_, index) => runWorkerSlot("download", index + 1, downloadJobTypes),
    ),
    ...Array.from(
      { length: config.WORKER_CONCURRENCY },
      (_, index) => runWorkerSlot("processing", index + 1, processingJobTypes),
    ),
    runAutomationSchedulers(),
  ],
);
await sql.end({ timeout: 10 });
