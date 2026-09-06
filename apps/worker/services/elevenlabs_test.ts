import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { scribeProcessingResult, transcribeWithScribe } from "./elevenlabs.ts";

const episodeId = "100065d7-a95c-45f8-872c-bb16fd455c9f";
const response = {
  language_code: "ces",
  text: "Ahoj světe. Dobrý den.",
  words: [
    { type: "word", text: "Ahoj", start: 0, end: 1, speaker_id: "speaker_4" },
    { type: "spacing", text: " ", start: 1, end: 1 },
    { type: "word", text: "světe.", start: 1, end: 2, speaker_id: "speaker_4" },
    { type: "word", text: "Dobrý den.", start: 3, end: 4, speaker_id: "speaker_7" },
  ],
};

Deno.test("Scribe zachová vlastní diarizaci, časy a nevymýšlí hlasové embeddingy", () => {
  const result = scribeProcessingResult(response, episodeId, "scribe_v2", 10);
  assertEquals(result.speakers.length, 2);
  assertEquals(result.utterances.map((item) => [item.text, item.speaker, item.start, item.end]), [
    ["Ahoj světe.", "SPEAKER_00", 0, 2],
    ["Dobrý den.", "SPEAKER_01", 3, 4],
  ]);
  assertEquals(result.speakers.map((speaker) => speaker.embedding), [null, null]);
  assertEquals(result.models.transcription.name, "scribe_v2");
  assertEquals(result.speakers[1]?.representativeSegments[0]?.start, 3);
});

Deno.test("Scribe přijme více než pět mluvčích a odmítne neplatné časy", () => {
  const words = Array.from({ length: 7 }, (_, i) => ({
    type: "word",
    text: `Hlas ${i}`,
    start: i,
    end: i + 0.5,
    speaker_id: `speaker_${i}`,
  }));
  assertEquals(
    scribeProcessingResult({ ...response, words }, episodeId, "scribe_v2", 10).speakers.length,
    7,
  );
  assertThrows(() =>
    scribeProcessingResult(
      { ...response, words: [{ ...words[0], end: -1 }] },
      episodeId,
      "scribe_v2",
      10,
    )
  );
  assertThrows(() =>
    scribeProcessingResult({ ...response, words: [] }, episodeId, "scribe_v2", 10)
  );
  assertThrows(() => scribeProcessingResult(response, episodeId, "scribe_v2", 1));
});

Deno.test("Scribe odešle soubor streamem s diarizací a validuje odpověď", async () => {
  const result = await transcribeWithScribe({
    audioPath: fromFileUrl(import.meta.url),
    apiKey: "test-key",
    model: "scribe_v2",
    language: "cs",
    timeoutMs: 1000,
    fetcher: async (url, init) => {
      assertEquals(url, "https://api.elevenlabs.io/v1/speech-to-text");
      assertEquals(new Headers(init?.headers).get("xi-api-key"), "test-key");
      assertEquals(init?.body instanceof ReadableStream, true);
      const bytes = await new Response(init?.body).arrayBuffer();
      assertEquals(bytes.byteLength, Number(new Headers(init?.headers).get("content-length")));
      const body = new TextDecoder().decode(bytes);
      assertStringIncludes(body, 'name="diarize"\r\n\r\ntrue');
      assertStringIncludes(body, 'name="model_id"\r\n\r\nscribe_v2');
      return Response.json(response);
    },
  });
  assertEquals(result.language_code, "ces");
  await assertRejects(
    () =>
      transcribeWithScribe({
        audioPath: fromFileUrl(import.meta.url),
        apiKey: "test-key",
        model: "scribe_v2",
        language: "cs",
        timeoutMs: 1000,
        fetcher: async (_url, init) => {
          await new Response(init?.body).arrayBuffer();
          return new Response("provider details", { status: 401 });
        },
      }),
    Error,
    "HTTP 401",
  );
});
