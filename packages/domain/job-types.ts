export const jobTypes = [
  "IMPORT_FEED",
  "DOWNLOAD_AUDIO",
  "NORMALIZE_AUDIO",
  "PROCESS_AUDIO_ML",
  "CHECK_AUDIO_ML_HEALTH",
  "IDENTIFY_SPEAKERS",
  "CREATE_CONTENT_CHUNKS",
  "CREATE_TEXT_EMBEDDINGS",
  "EXTRACT_CLAIMS",
] as const;

export type JobType = (typeof jobTypes)[number];
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobQueue = "download" | "processing";

export const downloadJobTypes = ["DOWNLOAD_AUDIO"] as const satisfies readonly JobType[];
export const processingJobTypes = jobTypes.filter((type) => type !== "DOWNLOAD_AUDIO");

export function jobQueue(type: JobType | string): JobQueue {
  return type === "DOWNLOAD_AUDIO" ? "download" : "processing";
}

export interface Job {
  id: string;
  type: JobType;
  entityType: string;
  entityId: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
}

export interface JobProgress {
  phase: string;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export type JobProgressReporter = (progress: JobProgress) => Promise<void>;
