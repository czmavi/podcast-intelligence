import { assertEquals } from "@std/assert";
import { scoreSpeakerCandidate } from "./speaker-scoring.ts";

Deno.test("speaker scoring agreguje více referencí a metadata jen jako slabší signál", () => {
  const score = scoreSpeakerCandidate({
    voiceSimilarities: [0.91, 0.88, 0.2, 0.9],
    expectedParticipant: true,
    regularHost: false,
    directAddressScore: 0.5,
  });
  assertEquals(score.voiceSimilarity, 0.9);
  assertEquals(score.evidence.referenceCount, 3);
  assertEquals(Math.round(score.combinedScore * 1000) / 1000, 0.824);
});

Deno.test("speaker scoring nevytvoří hlasovou jistotu jen z metadat", () => {
  const score = scoreSpeakerCandidate({
    voiceSimilarities: [],
    expectedParticipant: true,
    regularHost: true,
    directAddressScore: 0,
  });
  assertEquals(score.voiceSimilarity, 0);
  assertEquals(score.combinedScore, 0.18);
});
