import type { Sql } from "../client.ts";
import { type Job, type JobProgress, type JobType, jobTypes } from "../../domain/job-types.ts";
import { exponentialBackoffMs } from "../../shared/retry.ts";
import type postgres from "postgres";

export class JobRepository {
  constructor(private readonly sql: Sql) {}

  async enqueue(
    type: JobType,
    entityType: string,
    entityId: string,
    payload: unknown = {},
    priority = 0,
    maxAttempts = 3,
  ): Promise<string> {
    const rows = await this.sql`
      INSERT INTO jobs (type, entity_type, entity_id, payload, priority, max_attempts)
      VALUES (${type}, ${entityType}, ${entityId}, ${
      this.sql.json(toJson(payload))
    }, ${priority}, ${maxAttempts})
      ON CONFLICT (type, entity_id) WHERE status IN ('queued', 'running')
      DO UPDATE SET priority = GREATEST(jobs.priority, EXCLUDED.priority)
      RETURNING id
    `;
    return String(rows[0]?.id);
  }

  async claim(
    workerId: string,
    lockTimeoutSeconds: number,
    allowedTypes: readonly JobType[] = jobTypes,
  ): Promise<Job | null> {
    const claimTypes = [...allowedTypes];
    const rows = await this.sql`
      WITH candidate AS (
        SELECT id
        FROM jobs
        WHERE type = ANY(${claimTypes})
          AND (
            (status = 'queued' AND available_at <= now())
            OR (
              status = 'running'
              AND COALESCE(heartbeat_at, locked_at) <
                now() - (${lockTimeoutSeconds} * interval '1 second')
            )
          )
        ORDER BY priority DESC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs AS job
      SET status = 'running',
          attempts = attempts + 1,
          started_at = COALESCE(job.started_at, now()),
          locked_at = now(),
          heartbeat_at = now(),
          locked_by = ${workerId},
          error = NULL,
          progress_phase = NULL,
          progress_current = NULL,
          progress_total = NULL,
          progress_percent = NULL,
          progress_message = NULL,
          progress_updated_at = NULL
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*
    `;
    if (!rows[0]) return null;
    return rows[0] as unknown as Job;
  }

  async heartbeat(jobId: string, workerId: string): Promise<void> {
    await this.sql`
      UPDATE jobs SET heartbeat_at = now()
      WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'running'
    `;
  }

  async updateProgress(jobId: string, workerId: string, progress: JobProgress): Promise<void> {
    const percent = progress.percent ?? (
      progress.current !== undefined && progress.total !== undefined
        ? progress.current / progress.total * 100
        : null
    );
    await this.sql`
      UPDATE jobs
      SET progress_phase = ${progress.phase.slice(0, 100)},
          progress_current = ${progress.current ?? null},
          progress_total = ${progress.total ?? null},
          progress_percent = ${percent === null ? null : Math.max(0, Math.min(100, percent))},
          progress_message = ${progress.message?.slice(0, 500) ?? null},
          progress_updated_at = now(),
          heartbeat_at = now()
      WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'running'
    `;
  }

  async complete(jobId: string, workerId: string, result: unknown = {}) {
    await this.sql`
      UPDATE jobs
      SET status = 'completed', result = ${this.sql.json(toJson(result))}, completed_at = now(),
          heartbeat_at = now(), progress_percent = 100, progress_updated_at = now()
      WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'running'
    `;
  }

  async fail(job: Job, workerId: string, message: string, retryable: boolean): Promise<void> {
    const retry = retryable && job.attempts < job.maxAttempts;
    const delayMs = exponentialBackoffMs(job.attempts);
    await this.sql`
      UPDATE jobs
      SET status = ${retry ? "queued" : "failed"},
          error = ${message.slice(0, 4000)},
          available_at = ${retry ? new Date(Date.now() + delayMs) : new Date()},
          locked_at = NULL,
          locked_by = NULL,
          heartbeat_at = NULL,
          progress_message = ${retry ? "Čeká na další pokus." : message.slice(0, 500)},
          progress_updated_at = now(),
          completed_at = ${retry ? null : new Date()}
      WHERE id = ${job.id} AND locked_by = ${workerId}
    `;
  }
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
