import type { Config } from "../../../packages/shared/config.ts";
import {
  type ProcessAudioResponse,
  validateProcessAudioResponse,
} from "../../../packages/domain/schemas.ts";
import { DomainError } from "../../../packages/domain/errors.ts";
import type { JobProgressReporter } from "../../../packages/domain/job-types.ts";
import { z } from "zod";

interface ProcessAudioInput {
  episodeId: string;
  checkpointId: string;
  audioPath: string;
  audioFingerprint?: string;
  language: string | null;
  minSpeakers: number;
  maxSpeakers: number;
  enableDiarization: boolean;
  returnSpeakerEmbeddings: boolean;
  transcriptAlignmentMode: "segment" | "overlap";
}

const streamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    phase: z.string(),
    current: z.number().int().nonnegative().nullable(),
    total: z.number().int().positive().nullable(),
    message: z.string(),
  }),
  z.object({ type: z.literal("result"), data: z.unknown() }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().default(false),
    }),
  }),
]);

const audioMlDiagnosticSchema = z.object({
  status: z.enum(["ok", "critical"]),
  checks: z.array(z.object({
    name: z.string().min(1),
    ok: z.boolean(),
    message: z.string(),
  })),
  audioPipelineConcurrency: z.object({
    capacity: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
  }).optional(),
});

export type AudioMlDiagnostic = z.infer<typeof audioMlDiagnosticSchema>;

export function mlProgressPercent(
  phase: string,
  current: number | null,
  total: number | null,
): number | undefined {
  if (current === null || total === null || total <= 0) return undefined;
  const fraction = Math.max(0, Math.min(1, current / total));
  if (phase === "transcription") return fraction * 75;
  if (phase === "diarization") return 75 + fraction * 15;
  if (phase === "speaker_embeddings") return 90 + fraction * 10;
  return fraction * 100;
}

export class AudioMlClient {
  constructor(
    private readonly config: Pick<
      Config,
      "AUDIO_ML_URL" | "AUDIO_ML_API_TOKEN" | "AUDIO_ML_IDLE_TIMEOUT_MS"
    >,
  ) {}

  private headers(contentType = false): Headers {
    const headers = new Headers();
    if (contentType) headers.set("content-type", "application/json");
    if (this.config.AUDIO_ML_API_TOKEN) {
      headers.set("authorization", `Bearer ${this.config.AUDIO_ML_API_TOKEN}`);
    }
    return headers;
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.AUDIO_ML_URL}/health/ready`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async diagnose(): Promise<AudioMlDiagnostic> {
    let response: Response;
    try {
      response = await fetch(`${this.config.AUDIO_ML_URL}/health/diagnostics`, {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new DomainError(
        "Diagnostický endpoint Audio ML není dostupný.",
        "ML_DIAGNOSTICS_UNAVAILABLE",
        502,
        true,
      );
    }
    if (!response.ok) {
      throw new DomainError(
        `Diagnostika Audio ML vrátila HTTP ${response.status}.`,
        "ML_DIAGNOSTICS_ERROR",
        502,
        response.status >= 500,
      );
    }
    return audioMlDiagnosticSchema.parse(await response.json());
  }

  async process(
    input: ProcessAudioInput,
    reportProgress?: JobProgressReporter,
  ): Promise<ProcessAudioResponse> {
    const controller = new AbortController();
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = () => {
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), this.config.AUDIO_ML_IDLE_TIMEOUT_MS);
    };
    resetIdleTimeout();
    try {
      const response = await fetch(`${this.config.AUDIO_ML_URL}/v1/process-audio-stream`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      resetIdleTimeout();
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const error = body as { code?: string; message?: string; retryable?: boolean } | null;
        throw new DomainError(
          error?.message ?? `ML služba vrátila HTTP ${response.status}.`,
          error?.code ?? "ML_SERVICE_ERROR",
          502,
          error?.retryable ?? response.status >= 500,
        );
      }
      if (!response.body) {
        throw new DomainError("ML služba nevrátila datový stream.", "ML_STREAM");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: unknown;
      const handleLine = async (line: string): Promise<void> => {
        if (!line.trim()) return;
        resetIdleTimeout();
        const event = streamEventSchema.parse(JSON.parse(line));
        if (event.type === "progress") {
          const percent = mlProgressPercent(event.phase, event.current, event.total);
          await reportProgress?.({
            phase: event.phase,
            ...(event.current === null ? {} : { current: event.current }),
            ...(event.total === null ? {} : { total: event.total }),
            ...(percent === undefined ? {} : { percent }),
            message: event.message,
          });
        } else if (event.type === "result") {
          result = event.data;
        } else {
          throw new DomainError(event.error.message, event.error.code, 502, event.error.retryable);
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (value?.length) resetIdleTimeout();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) await handleLine(line);
        if (done) break;
      }
      await handleLine(buffer);
      if (result === undefined) {
        throw new DomainError("ML stream skončil bez výsledku.", "ML_STREAM", 502, true);
      }
      return validateProcessAudioResponse(result, input.episodeId);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainError(
          "Audio ML neposlalo po povolenou dobu žádný průběh.",
          "ML_IDLE_TIMEOUT",
          504,
          true,
        );
      }
      throw error;
    } finally {
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    }
  }
}
