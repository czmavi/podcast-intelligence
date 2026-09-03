import { z } from "zod";

const progressEventSchema = z.object({
  type: z.literal("progress"),
  phase: z.string(),
});
const resultEventSchema = z.object({ type: z.literal("result") });
const errorEventSchema = z.object({
  type: z.literal("error"),
  error: z.object({ message: z.string() }),
});
const healthSchema = z.object({
  audioPipelineConcurrency: z.object({
    capacity: z.number().int(),
    active: z.number().int(),
    waiting: z.number().int(),
  }),
});

interface RunResult {
  elapsedMs: number;
  phases: string[];
}

const [firstPath, secondPath] = Deno.args;
if (!firstPath || !secondPath) {
  throw new Error("Použití: benchmark-audio-concurrency.ts <audio-1> <audio-2>");
}

const baseUrl = Deno.env.get("AUDIO_ML_URL");
if (!baseUrl) throw new Error("AUDIO_ML_URL není nastavené.");
const token = Deno.env.get("AUDIO_ML_API_TOKEN");
const headers = new Headers({ "content-type": "application/json" });
if (token) headers.set("authorization", `Bearer ${token}`);

async function processAudio(path: string): Promise<RunResult> {
  const started = performance.now();
  const phases = new Set<string>();
  const response = await fetch(`${baseUrl}/v1/process-audio-stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      episodeId: crypto.randomUUID(),
      audioPath: path,
      language: "cs",
      minSpeakers: 1,
      maxSpeakers: 5,
      enableDiarization: true,
      returnSpeakerEmbeddings: true,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Audio ML vrátilo HTTP ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    const raw: unknown = JSON.parse(line);
    const progress = progressEventSchema.safeParse(raw);
    if (progress.success) {
      phases.add(progress.data.phase);
      return;
    }
    if (resultEventSchema.safeParse(raw).success) {
      completed = true;
      return;
    }
    const error = errorEventSchema.safeParse(raw);
    if (error.success) throw new Error(error.data.error.message);
    throw new Error("Audio ML poslalo neznámou stream událost.");
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
    if (done) break;
  }
  handleLine(buffer);
  if (!completed) throw new Error("Audio ML stream skončil bez výsledku.");
  return { elapsedMs: performance.now() - started, phases: [...phases] };
}

async function pipelineState(): Promise<z.infer<typeof healthSchema>["audioPipelineConcurrency"]> {
  const response = await fetch(`${baseUrl}/health/ready`, { headers });
  if (!response.ok) throw new Error(`Readiness vrátila HTTP ${response.status}.`);
  return healthSchema.parse(await response.json()).audioPipelineConcurrency;
}

const sequentialStarted = performance.now();
const sequential = [await processAudio(firstPath), await processAudio(secondPath)];
const sequentialElapsedMs = performance.now() - sequentialStarted;

let parallelFinished = false;
let maxActive = 0;
let maxWaiting = 0;
const monitor = (async () => {
  while (!parallelFinished) {
    const state = await pipelineState();
    maxActive = Math.max(maxActive, state.active);
    maxWaiting = Math.max(maxWaiting, state.waiting);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();
const parallelStarted = performance.now();
const parallel = await Promise.all([processAudio(firstPath), processAudio(secondPath)]);
const parallelElapsedMs = performance.now() - parallelStarted;
parallelFinished = true;
await monitor;

console.log(JSON.stringify(
  {
    sequential: {
      totalSeconds: sequentialElapsedMs / 1000,
      requestsSeconds: sequential.map((item) => item.elapsedMs / 1000),
    },
    parallel: {
      totalSeconds: parallelElapsedMs / 1000,
      requestsSeconds: parallel.map((item) => item.elapsedMs / 1000),
      maxActive,
      maxWaiting,
      phases: parallel.map((item) => item.phases),
    },
    throughputSpeedup: sequentialElapsedMs / parallelElapsedMs,
  },
  null,
  2,
));
