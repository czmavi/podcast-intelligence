import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ProcessAudioResponse } from "../domain/schemas.ts";
import {
  applyAsrCorrectionForMode,
  applyTranscriptCorrections,
  type AsrCorrectionProvider,
  correctDiarizedTranscript,
  formatAsrCorrectionDebug,
  OpenAiCompatibleAsrCorrectionProvider,
  type TranscriptCorrection,
} from "./asr-correction.ts";

const episodeId = "200065d7-a95c-45f8-872c-bb16fd455c9f";
const options = { autoApplyThreshold: 0.85, concurrency: 2, contextSeconds: 90 };

function proposal(
  originalText: string,
  replacementText: string,
  confidence = 0.94,
  startChar: number | null = null,
  endChar: number | null = null,
): TranscriptCorrection {
  return {
    originalText,
    replacementText,
    startChar,
    endChar,
    beforeContext: null,
    afterContext: null,
    reason: "english_term",
    confidence,
  };
}

function result(texts: readonly string[]): ProcessAudioResponse {
  return {
    schemaVersion: "3",
    episodeId,
    transcriptAlignmentMode: "overlap",
    durationSeconds: 300,
    detectedLanguage: "cs",
    models: {
      transcription: { name: "whisper", version: "alignment-v3" },
      diarization: { name: "pyannote", version: "4" },
      speakerEmbedding: null,
    },
    speakers: [
      {
        label: "SPEAKER_00",
        speechSeconds: 30,
        segmentCount: 2,
        representativeSegments: [],
        embedding: null,
      },
      {
        label: "SPEAKER_02",
        speechSeconds: 15,
        segmentCount: 1,
        representativeSegments: [],
        embedding: null,
      },
    ],
    utterances: texts.map((text, sequence) => ({
      sequence,
      start: 100 + sequence * 5,
      end: 105 + sequence * 5,
      playbackStart: 98 + sequence * 5,
      speaker: sequence === 1 ? "SPEAKER_02" : "SPEAKER_00",
      text,
      transcriptionConfidence: sequence === 1 ? 0.61 : 0.9,
      speakerConfidence: 0.88,
      overlapDetected: sequence === 1,
    })),
    warnings: [],
  };
}

Deno.test("stávající režim ASR correction provider vůbec nevolá", async () => {
  let calls = 0;
  const provider: AsrCorrectionProvider = {
    modelName: "test-model",
    correct: () => {
      calls += 1;
      return Promise.resolve({ edits: [] });
    },
  };
  const raw = result(["Původní přepis."]);
  const output = await applyAsrCorrectionForMode(raw, "overlap", provider, options);
  assertEquals(output, raw);
  assertEquals(calls, 0);
});

Deno.test("nový režim opraví anglicismus s kontextem napříč mluvčími", async () => {
  const raw = result([
    "U startupů hledáme menší cílový trh.",
    "Je to poměrně specifická níž pro tento produkt.",
    "Especially for SaaS products.",
  ]);
  const target = raw.utterances[1]!;
  const start = target.text.indexOf("níž");
  const provider: AsrCorrectionProvider = {
    modelName: "test-model",
    correct(request) {
      if (request.target.sequence !== 1) return Promise.resolve({ edits: [] });
      assertEquals(request.previous[0]?.speaker, "SPEAKER_00");
      assertEquals(request.following[0]?.speaker, "SPEAKER_00");
      assertEquals(request.episode?.title, "Startup podcast");
      return Promise.resolve({ edits: [proposal("níž", "niche", 0.94, start, start + 3)] });
    },
  };
  const output = await applyAsrCorrectionForMode(
    raw,
    "overlap_asr_corrected",
    provider,
    options,
    { title: "Startup podcast", description: "SaaS a produktová strategie" },
  );
  const corrected = output.utterances[1]!;
  assertEquals(corrected.text, "Je to poměrně specifická niche pro tento produkt.");
  assertEquals(corrected.rawText, target.text);
  assertEquals(corrected.speaker, "SPEAKER_02");
  assertEquals(corrected.start, 105);
  assertEquals(corrected.end, 110);
  assertEquals(corrected.playbackStart, 103);
  assertEquals(corrected.overlapDetected, true);
  assertEquals(output.asrCorrection?.appliedEdits, 1);
});

Deno.test("platné české níž zůstane bez úpravy", async () => {
  const raw = result(["Dej ten mikrofon trochu níž."]);
  const provider: AsrCorrectionProvider = {
    modelName: "test-model",
    correct: () => Promise.resolve({ edits: [] }),
  };
  const output = await applyAsrCorrectionForMode(
    raw,
    "overlap_asr_corrected",
    provider,
    options,
  );
  assertEquals(output.utterances[0]?.text, "Dej ten mikrofon trochu níž.");
  assertEquals(output.utterances[0]?.rawText, "Dej ten mikrofon trochu níž.");
});

Deno.test("kontext Prahy dovolí opravit název Letná", async () => {
  const raw = result([
    "Bavili jsme se o pražských čtvrtích.",
    "Potkali jsme se na Letný.",
    "Pak jsme šli přes Letenské náměstí.",
  ]);
  const provider: AsrCorrectionProvider = {
    modelName: "test-model",
    correct(request) {
      return Promise.resolve({
        edits: request.target.sequence === 1
          ? [{ ...proposal("Letný", "Letné"), reason: "place_name" }]
          : [],
      });
    },
  };
  const output = await applyAsrCorrectionForMode(
    raw,
    "overlap_asr_corrected",
    provider,
    options,
  );
  assertEquals(output.utterances[1]?.text, "Potkali jsme se na Letné.");
  assertEquals(output.utterances[1]?.corrections?.[0]?.reason, "place_name");
});

Deno.test("neplatné, nejednoznačné, kolidující a málo jisté edity se bezpečně odmítnou", () => {
  const invalid = applyTranscriptCorrections(
    "níž níž abcd",
    [
      proposal("neexistuje", "niche"),
      proposal("níž", "niche"),
      proposal("abcd", "x", 0.2),
      proposal("abc", "X", 0.95, 8, 11),
      proposal("bcd", "Y", 0.95, 9, 12),
    ],
    0.85,
  );
  assertEquals(invalid.text, "níž níž abcd");
  assertEquals(invalid.corrections.map((item) => item.rejectionReason).toSorted(), [
    "ambiguous_source",
    "below_threshold",
    "overlapping_edit",
    "overlapping_edit",
    "source_not_found",
  ]);

  const duplicate = applyTranscriptCorrections(
    "specifická níž",
    [proposal("níž", "niche", 0.95, 11, 14), proposal("níž", "niche", 0.96, 11, 14)],
    0.85,
  );
  assertEquals(duplicate.text, "specifická níž");
  assert(duplicate.corrections.every((item) => item.rejectionReason === "overlapping_edit"));
});

Deno.test("okolní text bezpečně rozliší opakovaný zdrojový výraz", () => {
  const edit = {
    ...proposal("níž", "niche"),
    beforeContext: "specifická ",
    afterContext: " pro produkt",
  };
  const output = applyTranscriptCorrections(
    "Dej to níž; specifická níž pro produkt.",
    [edit],
    0.85,
  );
  assertEquals(output.text, "Dej to níž; specifická niche pro produkt.");
});

Deno.test("selhání jednoho modelového volání zachová jeho raw text a pokračuje", async () => {
  const raw = result(["První níž.", "Druhá níž.", "Třetí níž."]);
  const provider: AsrCorrectionProvider = {
    modelName: "test-model",
    correct(request) {
      if (request.target.sequence === 1) return Promise.reject(new Error("model unavailable"));
      return Promise.resolve({ edits: [proposal("níž", "niche")] });
    },
  };
  const output = await correctDiarizedTranscript(raw.utterances, provider, options);
  assertEquals(output.utterances.map((item) => item.text), [
    "První niche.",
    "Druhá níž.",
    "Třetí niche.",
  ]);
  assertEquals(output.utterances[1]?.rawText, "Druhá níž.");
  assertEquals(output.summary.modelFailures, 1);
  assertEquals(output.summary.status, "partial");
});

Deno.test("malformovaný structured output selže jen pro cílovou promluvu", async () => {
  const provider = new OpenAiCompatibleAsrCorrectionProvider({
    baseUrl: "http://model.test/v1",
    model: "test-model",
    timeoutMs: 1000,
    protocol: "vllm",
  }, (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assertEquals((body.response_format as { type: string }).type, "json_schema");
    return Promise.resolve(Response.json({
      choices: [{ message: { content: '{"edits":[{"unexpected":true}]}' } }],
    }));
  });
  const raw = result(["Původní níž."]);
  const output = await correctDiarizedTranscript(raw.utterances, provider, options);
  assertEquals(output.utterances[0]?.text, "Původní níž.");
  assertEquals(output.summary.modelFailures, 1);
});

Deno.test("OpenAI correction request nepoužívá vLLM-only parametry", async () => {
  const provider = new OpenAiCompatibleAsrCorrectionProvider({
    baseUrl: "https://api.openai.test/v1",
    model: "gpt-test",
    apiKey: "secret",
    timeoutMs: 1000,
    protocol: "openai",
  }, (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assertEquals(body.max_completion_tokens, 2000);
    assertEquals(body.max_tokens, undefined);
    assertEquals(body.chat_template_kwargs, undefined);
    assertEquals(body.temperature, undefined);
    return Promise.resolve(Response.json({
      choices: [{ message: { content: '{"edits":[]}' } }],
    }));
  });
  const response = await provider.correct({
    previous: [],
    target: result(["Původní text."]).utterances[0]!,
    following: [],
  });
  assertEquals(response.edits, []);
});

Deno.test("debug reprezentace ukáže audit bez změny speaker metadat", () => {
  const raw = result(["Specifická níž."]).utterances[0]!;
  const corrected = applyTranscriptCorrections(raw.text, [proposal("níž", "niche")], 0.85);
  const debug = formatAsrCorrectionDebug({
    ...raw,
    rawText: raw.text,
    text: corrected.text,
    corrections: corrected.corrections,
  });
  assertStringIncludes(debug, "Speaker: SPEAKER_00");
  assertStringIncludes(debug, "níž → niche");
  assertStringIncludes(debug, "confidence: 0.94");
});
