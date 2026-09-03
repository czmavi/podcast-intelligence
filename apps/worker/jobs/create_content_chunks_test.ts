import { assertEquals } from "@std/assert";
import { type ChunkUtterance, createContentChunks } from "./create_content_chunks.ts";

function utterance(
  id: string,
  speaker: string,
  text: string,
  personId: string | null = null,
): ChunkUtterance {
  const start = Number(id) * 10;
  return {
    id,
    startSeconds: start,
    endSeconds: start + 8,
    playbackStartSeconds: start,
    text,
    personId,
    speakerClusterId: speaker,
    overlapDetected: false,
  };
}

Deno.test("chunking vrací prázdný seznam pro prázdný přepis", () => {
  assertEquals(createContentChunks([]), []);
});

Deno.test("chunking zachová celé utterances i neznámého mluvčího", () => {
  const chunks = createContentChunks([
    utterance("1", "A", "Krátká otázka"),
    utterance("2", "B", "Delší odpověď hosta", "person-1"),
  ], { targetWords: 3, maxWords: 5, overlapUtterances: 0 });
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0]?.utteranceIds, ["1", "2"]);
  assertEquals(chunks[0]?.personIds, ["person-1"]);
  assertEquals(chunks[0]?.playbackStartSeconds, 10);
});

Deno.test("chunking ponechá dlouhou souvislou odpověď pohromadě do maxima", () => {
  const chunks = createContentChunks([
    utterance("1", "A", "jedna dvě tři"),
    utterance("2", "A", "čtyři pět šest"),
    utterance("3", "B", "sedm osm"),
  ], { targetWords: 4, maxWords: 8, overlapUtterances: 0 });
  assertEquals(chunks[0]?.utteranceIds, ["1", "2"]);
  assertEquals(chunks[1]?.utteranceIds, ["3"]);
});

Deno.test("chunking umí překryv sousedních chunků", () => {
  const chunks = createContentChunks([
    utterance("1", "A", "jedna dvě"),
    utterance("2", "B", "tři čtyři"),
    utterance("3", "A", "pět šest"),
  ], { targetWords: 4, maxWords: 4, overlapUtterances: 1 });
  assertEquals(chunks[0]?.utteranceIds, ["1", "2"]);
  assertEquals(chunks[1]?.utteranceIds, ["2", "3"]);
});
