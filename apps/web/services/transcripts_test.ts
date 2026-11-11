import { assertEquals, assertStringIncludes } from "@std/assert";
import { transcriptComparison, transcriptLabel, transcriptVariantsSection } from "./transcripts.ts";

Deno.test("jediný vybraný přepis nevyzývá k výběru ani porovnání", () => {
  const output = transcriptVariantsSection(
    { id: "episode", activeProcessingRunId: "run", transcriptSelectionPending: false },
    [{ id: "run", startedAt: "2026-10-26T10:00:00Z" }],
    false,
  );
  assertStringIncludes(output, "Vybraný přepis");
  assertStringIncludes(output, "Zobrazit přepis");
  assertEquals(output.includes("Použít pro přiřazení hlasů"), false);
  assertEquals(output.includes("Zobrazit / porovnat"), false);
});

Deno.test("varianty ukazují model, samostatný počet hlasů a nutnost vybrat přepis", () => {
  const run = {
    id: "run",
    transcriptionProvider: "elevenlabs",
    transcriptionModel: "scribe_v2",
    speakerCount: 4,
    utteranceCount: 10,
    startedAt: "2026-09-06T10:00:00Z",
  };
  const output = transcriptVariantsSection(
    { id: "episode", transcriptSelectionPending: true, originalAudioPath: "/audio" },
    [run],
    false,
  );
  assertStringIncludes(output, "4 mluvčích");
  assertStringIncludes(output, "scribe_v2");
  assertStringIncludes(output, "Použít pro přiřazení hlasů");
  assertStringIncludes(output, 'value="elevenlabs" disabled');
  assertStringIncludes(
    transcriptLabel({
      transcriptionModel: "Cem13/whisper-large-v3-czech",
      transcriptAlignmentMode: "overlap",
    }),
    "překryvy",
  );
});

Deno.test("porovnání zarovná rozdílné segmenty podle času a escapuje přepisy", () => {
  const output = transcriptComparison([
    { startSeconds: 2, playbackStartSeconds: 1, localLabel: "SPEAKER_00", text: "<script>" },
  ], [
    { startSeconds: 3, localLabel: "SPEAKER_01", text: "Jiný text" },
    { startSeconds: 35, localLabel: "SPEAKER_02", text: "Další" },
  ]);
  assertEquals((output.match(/transcript-comparison-row/g) ?? []).length, 2);
  assertStringIncludes(output, "&lt;script&gt;");
  assertStringIncludes(output, 'data-seek="1"');
  assertStringIncludes(output, "transcript-different");
  assertStringIncludes(output, "SPEAKER_02");
});
