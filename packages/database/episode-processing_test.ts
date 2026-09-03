import { assertEquals } from "@std/assert";
import { episodeSchedulingStep } from "./episode-processing.ts";

Deno.test("plánování zvolí první chybějící artefakt epizody", () => {
  assertEquals(
    episodeSchedulingStep({
      originalAudioPath: null,
      normalizedAudioPath: null,
      activeProcessingRunId: null,
    }),
    { type: "DOWNLOAD_AUDIO", status: "download_queued" },
  );
  assertEquals(
    episodeSchedulingStep({
      originalAudioPath: "/data/original.mp3",
      normalizedAudioPath: null,
      activeProcessingRunId: null,
    }),
    { type: "NORMALIZE_AUDIO", status: "normalization_queued" },
  );
  assertEquals(
    episodeSchedulingStep({
      originalAudioPath: "/data/original.mp3",
      normalizedAudioPath: "/data/audio.wav",
      activeProcessingRunId: null,
    }),
    { type: "PROCESS_AUDIO_ML", status: "transcription_queued" },
  );
  assertEquals(
    episodeSchedulingStep({
      originalAudioPath: "/data/original.mp3",
      normalizedAudioPath: "/data/audio.wav",
      activeProcessingRunId: "run-id",
    }),
    { type: "CREATE_CONTENT_CHUNKS", status: "indexing_queued" },
  );
  assertEquals(
    episodeSchedulingStep({
      originalAudioPath: "/data/original.mp3",
      normalizedAudioPath: "/data/audio.wav",
      activeProcessingRunId: "run-id",
    }, "full"),
    { type: "PROCESS_AUDIO_ML", status: "transcription_queued" },
  );
});
