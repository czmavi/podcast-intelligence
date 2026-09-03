import { assertEquals } from "@std/assert";
import { DomainError } from "../../../packages/domain/errors.ts";
import { AudioMlClient, mlProgressPercent } from "./ml-client.ts";

Deno.test("ML progress skládá fáze do jednoho rostoucího procenta", () => {
  assertEquals(mlProgressPercent("transcription", 1, 2), 37.5);
  assertEquals(mlProgressPercent("transcription", 2, 2), 75);
  assertEquals(mlProgressPercent("diarization", 1, 1), 90);
  assertEquals(mlProgressPercent("speaker_embeddings", 2, 2), 100);
});

Deno.test({
  name: "audio ML klient ukončí jen neaktivní stream",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const originalFetch = globalThis.fetch;
    const stalledFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    globalThis.fetch = stalledFetch;
    try {
      const client = new AudioMlClient({
        AUDIO_ML_URL: "http://audio-ml.test",
        AUDIO_ML_API_TOKEN: undefined,
        AUDIO_ML_IDLE_TIMEOUT_MS: 5,
      });
      try {
        await client.process({
          episodeId: "200065d7-a95c-45f8-872c-bb16fd455c9f",
          checkpointId: "100065d7-a95c-45f8-872c-bb16fd455c9f",
          audioPath: "/data/audio.wav",
          language: "cs",
          minSpeakers: 1,
          maxSpeakers: 5,
          enableDiarization: true,
          returnSpeakerEmbeddings: true,
          transcriptAlignmentMode: "segment",
        });
        throw new Error("Neaktivní stream měl skončit timeoutem.");
      } catch (error) {
        assertEquals(error instanceof DomainError, true);
        assertEquals((error as DomainError).code, "ML_IDLE_TIMEOUT");
        assertEquals((error as DomainError).retryable, true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test("audio ML klient validuje čerstvou diagnostiku", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input, init) => {
    assertEquals(init?.method, "POST");
    return Promise.resolve(Response.json({
      status: "critical",
      checks: [{ name: "fresh_cuda", ok: false, message: "NVML 999" }],
      audioPipelineConcurrency: { capacity: 1, active: 0, waiting: 0 },
    }));
  }) as typeof fetch;
  try {
    const client = new AudioMlClient({
      AUDIO_ML_URL: "http://audio-ml.test",
      AUDIO_ML_API_TOKEN: undefined,
      AUDIO_ML_IDLE_TIMEOUT_MS: 60_000,
    });
    const diagnostic = await client.diagnose();
    assertEquals(diagnostic.status, "critical");
    assertEquals(diagnostic.checks[0]?.name, "fresh_cuda");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
