import { createHash } from "node:crypto";
import { basename, join } from "@std/path";
import { DomainError } from "../../../packages/domain/errors.ts";

const extensionByMime: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

function extensionFor(url: string, mime: string | null): string {
  if (mime && extensionByMime[mime.split(";")[0]?.trim().toLowerCase() ?? ""]) {
    return extensionByMime[mime.split(";")[0]!.trim().toLowerCase()]!;
  }
  const candidate = basename(new URL(url).pathname).split(".").pop()?.toLowerCase();
  return candidate && /^[a-z0-9]{1,5}$/.test(candidate) ? candidate : "audio";
}

export interface DownloadResult {
  path: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
}

export async function downloadAudio(
  url: string,
  targetDirectory: string,
  knownSize: number | null,
  timeoutMs = 120_000,
): Promise<DownloadResult> {
  await Deno.mkdir(targetDirectory, { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const tempPath = join(targetDirectory, `.download-${crypto.randomUUID()}.tmp`);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "PodcastIntelligence/0.1" },
    });
    if (!response.ok || !response.body) {
      throw new DomainError(
        `Stažení audia selhalo: HTTP ${response.status}.`,
        "AUDIO_DOWNLOAD_FAILED",
        502,
        response.status >= 500 || response.status === 429,
      );
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream";
    const extension = extensionFor(url, mimeType);
    const targetPath = join(targetDirectory, `audio.${extension}`);
    try {
      const stat = await Deno.stat(targetPath);
      if (stat.isFile && stat.size > 0 && (!knownSize || stat.size === knownSize)) {
        const hasher = createHash("sha256");
        const file = await Deno.open(targetPath, { read: true });
        try {
          for await (const chunk of file.readable) hasher.update(chunk);
        } finally {
          try {
            file.close();
          } catch {
            // The readable stream can close the file automatically.
          }
        }
        return { path: targetPath, sha256: hasher.digest("hex"), byteSize: stat.size, mimeType };
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    const hasher = createHash("sha256");
    let byteSize = 0;
    const file = await Deno.open(tempPath, { createNew: true, write: true });
    try {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        byteSize += value.byteLength;
        hasher.update(value);
        let written = 0;
        while (written < value.byteLength) written += await file.write(value.subarray(written));
      }
      await file.sync();
    } finally {
      file.close();
    }
    if (byteSize === 0) throw new DomainError("Stažené audio je prázdné.", "EMPTY_AUDIO", 422);
    await Deno.rename(tempPath, targetPath);
    return { path: targetPath, sha256: hasher.digest("hex"), byteSize, mimeType };
  } catch (error) {
    try {
      await Deno.remove(tempPath);
    } catch {
      // Cleanup is best effort.
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new DomainError("Stažení audia vypršelo.", "AUDIO_DOWNLOAD_TIMEOUT", 504, true);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function commandOutput(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<Deno.CommandOutput> {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have finished between timeout and kill.
      }
      reject(new DomainError(`${command} překročil timeout.`, "COMMAND_TIMEOUT", 504, true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([child.output(), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface AudioInspection {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

export async function inspectAudio(path: string, timeoutMs = 30_000): Promise<AudioInspection> {
  const output = await commandOutput("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate,channels:format=duration",
    "-of",
    "json",
    path,
  ], timeoutMs);
  if (!output.success) {
    throw new DomainError(
      `ffprobe selhal: ${new TextDecoder().decode(output.stderr).slice(-1000)}`,
      "INVALID_AUDIO",
      422,
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    streams?: Array<{ sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const result = {
    durationSeconds: Number(parsed.format?.duration),
    sampleRate: Number(stream?.sample_rate),
    channels: Number(stream?.channels),
  };
  if (!Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) {
    throw new DomainError("ffprobe nevrátil platnou délku audia.", "INVALID_AUDIO", 422);
  }
  return result;
}

export async function normalizeAudio(
  inputPath: string,
  targetDirectory: string,
  timeoutMs = 3_600_000,
): Promise<{ path: string; byteSize: number; inspection: AudioInspection }> {
  await Deno.mkdir(targetDirectory, { recursive: true });
  const targetPath = join(targetDirectory, "audio.wav");
  const tempPath = join(targetDirectory, `.normalize-${crypto.randomUUID()}.wav`);
  try {
    try {
      const existing = await inspectAudio(targetPath);
      const stat = await Deno.stat(targetPath);
      if (existing.sampleRate === 16000 && existing.channels === 1 && stat.size > 0) {
        return { path: targetPath, byteSize: stat.size, inspection: existing };
      }
    } catch {
      // Invalid or missing previous output is replaced.
    }
    const output = await commandOutput("ffmpeg", [
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      tempPath,
    ], timeoutMs);
    if (!output.success) {
      throw new DomainError(
        `ffmpeg selhal: ${new TextDecoder().decode(output.stderr).slice(-2000)}`,
        "AUDIO_NORMALIZATION_FAILED",
        422,
      );
    }
    const inspection = await inspectAudio(tempPath);
    if (inspection.sampleRate !== 16000 || inspection.channels !== 1) {
      throw new DomainError("Normalizované audio nemá 16 kHz mono.", "INVALID_NORMALIZED_AUDIO");
    }
    const stat = await Deno.stat(tempPath);
    if (!stat.isFile || stat.size === 0) throw new Error("Normalizovaný soubor je prázdný.");
    await Deno.rename(tempPath, targetPath);
    return { path: targetPath, byteSize: stat.size, inspection };
  } catch (error) {
    try {
      await Deno.remove(tempPath);
    } catch {
      // Cleanup is best effort.
    }
    throw error;
  }
}
