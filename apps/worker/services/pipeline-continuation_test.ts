import { assertEquals } from "@std/assert";
import { nextPipelineStep, shouldContinuePipeline } from "./pipeline-continuation.ts";

Deno.test("hromadně předstažené audio nepokračuje rovnou do ML pipeline", () => {
  assertEquals(
    shouldContinuePipeline({
      type: "DOWNLOAD_AUDIO",
      payload: { continuePipeline: false, source: "bulk_prefetch" },
    }),
    false,
  );
  assertEquals(shouldContinuePipeline({ type: "DOWNLOAD_AUDIO", payload: {} }), true);
  assertEquals(
    shouldContinuePipeline({ type: "NORMALIZE_AUDIO", payload: { continuePipeline: false } }),
    false,
  );
});

Deno.test("doplňková identifikace hosta znovu nespustí indexaci", () => {
  assertEquals(
    nextPipelineStep({
      type: "IDENTIFY_SPEAKERS",
      payload: { continuePipeline: false, source: "manual_moderator_assignment" },
    }),
    null,
  );
});

Deno.test("uložení nebo výběr přepisu řídí identifikaci, obecná pipeline naváže až chunkingem", () => {
  assertEquals(nextPipelineStep({ type: "PROCESS_AUDIO_ML", payload: {} }), null);
  assertEquals(nextPipelineStep({ type: "IDENTIFY_SPEAKERS", payload: {} }), {
    type: "CREATE_CONTENT_CHUNKS",
    status: "indexing_queued",
  });
});
