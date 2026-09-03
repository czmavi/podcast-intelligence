import { assertEquals, assertThrows } from "@std/assert";
import {
  assignSpeakerSchema,
  processEpisodeSchema,
  searchSchema,
  updatePodcastAutoProcessingSchema,
  updatePodcastAutoRefreshSchema,
  updatePodcastTranscriptAlignmentSchema,
  updateUtteranceSpeakerSchema,
  validateProcessAudioResponse,
} from "./schemas.ts";

Deno.test("zpracování epizody rozlišuje pokračování a plný nový run", () => {
  assertEquals(processEpisodeSchema.parse({}).mode, "resume");
  assertEquals(processEpisodeSchema.parse({ mode: "full" }).mode, "full");
});

Deno.test("podcast rozlišuje stabilní, překryvové a ASR korigované zarovnání", () => {
  assertEquals(updatePodcastTranscriptAlignmentSchema.parse({ mode: "segment" }).mode, "segment");
  assertEquals(updatePodcastTranscriptAlignmentSchema.parse({ mode: "overlap" }).mode, "overlap");
  assertEquals(
    updatePodcastTranscriptAlignmentSchema.parse({ mode: "overlap_asr_corrected" }).mode,
    "overlap_asr_corrected",
  );
});

Deno.test("podcast přijímá boolean přepínače automatizace", () => {
  assertEquals(updatePodcastAutoProcessingSchema.parse({ enabled: true }).enabled, true);
  assertEquals(updatePodcastAutoRefreshSchema.parse({ enabled: false }).enabled, false);
});

Deno.test("ML validace odmítne neznámý speaker label", () => {
  assertThrows(() =>
    validateProcessAudioResponse({
      schemaVersion: "1",
      episodeId: "200065d7-a95c-45f8-872c-bb16fd455c9f",
      durationSeconds: 10,
      detectedLanguage: "cs",
      models: {
        transcription: { name: "whisper", version: null },
        diarization: null,
        speakerEmbedding: null,
      },
      speakers: [],
      utterances: [{
        sequence: 0,
        start: 1,
        end: 2,
        speaker: "SPEAKER_00",
        text: "Test",
        transcriptionConfidence: null,
        speakerConfidence: null,
        overlapDetected: false,
      }],
      warnings: [],
    })
  );
});

Deno.test("ML validace v režimu překryvů zachová samostatný čas přehrávání", () => {
  const output = validateProcessAudioResponse({
    schemaVersion: "3",
    episodeId: "200065d7-a95c-45f8-872c-bb16fd455c9f",
    transcriptAlignmentMode: "overlap",
    durationSeconds: 20,
    detectedLanguage: "cs",
    models: {
      transcription: { name: "whisper", version: "alignment-v3" },
      diarization: { name: "pyannote", version: "4" },
      speakerEmbedding: null,
    },
    speakers: [{
      label: "SPEAKER_00",
      speechSeconds: 10,
      segmentCount: 1,
      representativeSegments: [],
      embedding: null,
    }],
    utterances: [{
      sequence: 0,
      start: 10,
      end: 12,
      playbackStart: 7,
      speaker: "SPEAKER_00",
      text: "Test",
      transcriptionConfidence: null,
      speakerConfidence: 0.9,
      overlapDetected: true,
    }],
    warnings: [],
  });

  assertEquals(output.transcriptAlignmentMode, "overlap");
  assertEquals(output.utterances[0]?.playbackStart, 7);
});

Deno.test("vyhledávání vyžaduje podcast a přijímá volitelnou epizodu", () => {
  const podcastId = "200065d7-a95c-45f8-872c-bb16fd455c9f";
  const episodeId = "99c07a61-ccaf-4c86-9fcb-09c6407bf5a2";
  assertEquals(searchSchema.safeParse({ query: "test" }).success, false);
  const parsed = searchSchema.parse({ query: "test", podcastId, episodeId });
  assertEquals(parsed.podcastId, podcastId);
  assertEquals(parsed.episodeId, episodeId);
});

Deno.test("přiřazení hlasu rozlišuje existující a nové osoby", () => {
  const personId = "200065d7-a95c-45f8-872c-bb16fd455c9f";
  assertEquals(
    assignSpeakerSchema.parse({ assignmentType: "moderator", personId }).assignmentType,
    "moderator",
  );
  assertEquals(
    assignSpeakerSchema.parse({ assignmentType: "guest", personId }).assignmentType,
    "guest",
  );
  const newGuest = assignSpeakerSchema.parse({
    assignmentType: "newGuest",
    displayName: "  Jana Nováková  ",
  });
  assertEquals(newGuest.assignmentType, "newGuest");
  if (newGuest.assignmentType === "newGuest") assertEquals(newGuest.displayName, "Jana Nováková");
  const newModerator = assignSpeakerSchema.parse({
    assignmentType: "newModerator",
    displayName: "  Petr Moderátor  ",
    description: "  Stálý člen pořadu  ",
  });
  assertEquals(newModerator.assignmentType, "newModerator");
  if (newModerator.assignmentType === "newModerator") {
    assertEquals(newModerator.displayName, "Petr Moderátor");
    assertEquals(newModerator.description, "Stálý člen pořadu");
  }
  assertEquals(
    assignSpeakerSchema.safeParse({ assignmentType: "newGuest", displayName: "   " }).success,
    false,
  );
  assertEquals(
    assignSpeakerSchema.safeParse({ assignmentType: "moderator", displayName: "Bez ID" }).success,
    false,
  );
});

Deno.test("oprava mluvčího promluvy přijme osobu, neznámého i návrat ke clusteru", () => {
  const personId = "200065d7-a95c-45f8-872c-bb16fd455c9f";
  assertEquals(updateUtteranceSpeakerSchema.parse({ speaker: personId }).speaker, personId);
  assertEquals(updateUtteranceSpeakerSchema.parse({ speaker: "unknown" }).speaker, "unknown");
  assertEquals(updateUtteranceSpeakerSchema.parse({ speaker: "cluster" }).speaker, "cluster");
  assertEquals(updateUtteranceSpeakerSchema.safeParse({ speaker: "neplatné" }).success, false);
});
