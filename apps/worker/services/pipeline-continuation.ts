import type { Job, JobType } from "../../../packages/domain/job-types.ts";

export interface NextPipelineStep {
  type: JobType;
  status: string;
}

export function shouldContinuePipeline(job: Pick<Job, "type" | "payload">): boolean {
  return job.payload.continuePipeline !== false;
}

export function nextPipelineStep(
  job: Pick<Job, "type" | "payload">,
): NextPipelineStep | null {
  // A transcript must be selected before identifying people or indexing it.
  if (job.type === "PROCESS_AUDIO_ML") return null;
  if (!shouldContinuePipeline(job)) return null;
  const next: Partial<Record<JobType, NextPipelineStep>> = {
    DOWNLOAD_AUDIO: { type: "NORMALIZE_AUDIO", status: "normalization_queued" },
    NORMALIZE_AUDIO: { type: "PROCESS_AUDIO_ML", status: "transcription_queued" },
    IDENTIFY_SPEAKERS: { type: "CREATE_CONTENT_CHUNKS", status: "indexing_queued" },
    CREATE_CONTENT_CHUNKS: { type: "CREATE_TEXT_EMBEDDINGS", status: "indexing_queued" },
  };
  return next[job.type] ?? null;
}
