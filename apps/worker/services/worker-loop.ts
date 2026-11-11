import type { Job } from "../../../packages/domain/job-types.ts";
import { exponentialBackoffMs } from "../../../packages/shared/retry.ts";

export interface WorkerLoopFailure {
  jobId: string | null;
  consecutiveFailures: number;
  retryInMs: number;
}

export interface WorkerLoopOptions {
  claim: () => Promise<Job | null>;
  process: (job: Job) => Promise<void>;
  shouldStop: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  onError: (error: unknown, failure: WorkerLoopFailure) => void;
}

/** Keep a slot alive when claiming or persisting a job fails during a database outage. */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  let consecutiveFailures = 0;
  while (!options.shouldStop()) {
    let job: Job | null = null;
    try {
      job = await options.claim();
      if (job) await options.process(job);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      const retryInMs = exponentialBackoffMs(
        consecutiveFailures,
        Math.max(1000, options.pollIntervalMs),
        30_000,
      );
      options.onError(error, { jobId: job?.id ?? null, consecutiveFailures, retryInMs });
      await options.wait(retryInMs);
      // Reclaim through the repository: an interrupted write may have committed, and a
      // running job whose failure could not be saved must retain its lease until expiry.
      continue;
    }
    if (!job) await options.wait(options.pollIntervalMs);
  }
}
