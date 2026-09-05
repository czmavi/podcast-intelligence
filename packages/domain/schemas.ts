import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const createPodcastSchema = z.object({
  rssUrl: z.string().url().max(2048).refine((url) => /^https?:\/\//i.test(url), {
    message: "RSS URL musí používat HTTP nebo HTTPS.",
  }),
});

export const updatePodcastAutoProcessingSchema = z.object({
  enabled: z.boolean(),
});

export const updatePodcastAutoDownloadSchema = z.object({
  enabled: z.boolean(),
});

export const updatePodcastAutoRefreshSchema = z.object({
  enabled: z.boolean(),
});

export const transcriptAlignmentModeSchema = z.enum([
  "segment",
  "overlap",
  "overlap_asr_corrected",
]);

export const updatePodcastTranscriptAlignmentSchema = z.object({
  mode: transcriptAlignmentModeSchema,
});

export type TranscriptAlignmentMode = z.infer<typeof transcriptAlignmentModeSchema>;

export const updateEpisodeRagExclusionSchema = z.object({
  excluded: z.boolean(),
});

export const processEpisodeSchema = z.object({
  mode: z.enum(["resume", "full"]).default("resume"),
});

export const createPersonSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  isRegularHost: z.boolean().default(false),
});

const speakerAssignmentVerificationShape = {
  verified: z.boolean().default(true),
  createReferenceEmbeddings: z.boolean().default(true),
  overwrite: z.boolean().default(false),
};

const newSpeakerPersonShape = {
  displayName: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  ...speakerAssignmentVerificationShape,
};

export const assignSpeakerSchema = z.discriminatedUnion("assignmentType", [
  z.object({
    assignmentType: z.literal("moderator"),
    personId: uuidSchema,
    ...speakerAssignmentVerificationShape,
  }),
  z.object({
    assignmentType: z.literal("guest"),
    personId: uuidSchema,
    ...speakerAssignmentVerificationShape,
  }),
  z.object({
    assignmentType: z.literal("newGuest"),
    ...newSpeakerPersonShape,
  }),
  z.object({
    assignmentType: z.literal("newModerator"),
    ...newSpeakerPersonShape,
  }),
]);

export type AssignSpeakerInput = z.infer<typeof assignSpeakerSchema>;

export const updateUtteranceSpeakerSchema = z.object({
  speaker: z.union([z.literal("cluster"), z.literal("unknown"), uuidSchema]),
});

export type UpdateUtteranceSpeakerInput = z.infer<typeof updateUtteranceSpeakerSchema>;

const modelInfo = z.object({ name: z.string().min(1), version: z.string().nullable() });
export const transcriptCorrectionReasonSchema = z.enum([
  "english_term",
  "proper_name",
  "place_name",
  "company_or_product",
  "technical_term",
  "abbreviation",
  "other_asr_error",
]);

export const transcriptCorrectionAuditSchema = z.object({
  originalText: z.string().min(1),
  replacementText: z.string().min(1),
  startChar: z.number().int().nonnegative().optional(),
  endChar: z.number().int().positive().optional(),
  beforeContext: z.string().optional(),
  afterContext: z.string().optional(),
  reason: transcriptCorrectionReasonSchema,
  confidence: z.number().min(0).max(1),
  applied: z.boolean(),
  rejectionReason: z.enum([
    "below_threshold",
    "invalid_replacement",
    "source_not_found",
    "ambiguous_source",
    "overlapping_edit",
  ]).optional(),
});

export const asrCorrectionSummarySchema = z.object({
  status: z.enum(["completed", "partial", "provider_unavailable"]),
  model: z.string().min(1).nullable(),
  contextSeconds: z.number().int().positive(),
  autoApplyThreshold: z.number().min(0).max(1),
  processedSegments: z.number().int().nonnegative(),
  proposedEdits: z.number().int().nonnegative(),
  appliedEdits: z.number().int().nonnegative(),
  rejectedBelowThreshold: z.number().int().nonnegative(),
  rejectedUnsafe: z.number().int().nonnegative(),
  modelFailures: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
});

const representativeSegment = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  quality: z.number().min(0).max(1),
}).refine((segment) => segment.end > segment.start, "Konec segmentu musí být po začátku.");

export const processAudioResponseSchema = z.object({
  schemaVersion: z.union([z.literal("1"), z.literal("2"), z.literal("3")]),
  episodeId: uuidSchema,
  transcriptAlignmentMode: transcriptAlignmentModeSchema.default("segment"),
  durationSeconds: z.number().positive(),
  detectedLanguage: z.string().min(2),
  models: z.object({
    transcription: modelInfo,
    diarization: modelInfo.nullable(),
    speakerEmbedding: modelInfo.nullable(),
  }),
  speakers: z.array(z.object({
    label: z.string().regex(/^SPEAKER_\d+$/),
    speechSeconds: z.number().nonnegative(),
    segmentCount: z.number().int().nonnegative(),
    representativeSegments: z.array(representativeSegment).max(5),
    embedding: z.array(z.number().finite()).nullable(),
  })),
  utterances: z.array(z.object({
    sequence: z.number().int().nonnegative(),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    playbackStart: z.number().nonnegative().optional(),
    speaker: z.string().regex(/^SPEAKER_\d+$/),
    text: z.string(),
    rawText: z.string().optional(),
    corrections: z.array(transcriptCorrectionAuditSchema).optional(),
    transcriptionConfidence: z.number().min(0).max(1).nullable(),
    speakerConfidence: z.number().min(0).max(1).nullable(),
    overlapDetected: z.boolean(),
  })),
  warnings: z.array(z.string()),
  asrCorrection: asrCorrectionSummarySchema.optional(),
});

export type ProcessAudioResponse = z.infer<typeof processAudioResponseSchema>;

export function validateProcessAudioResponse(
  input: unknown,
  expectedEpisodeId?: string,
): ProcessAudioResponse {
  const output = processAudioResponseSchema.parse(input);
  if (expectedEpisodeId && output.episodeId !== expectedEpisodeId) {
    throw new Error("ML odpověď patří jiné epizodě.");
  }
  const speakers = new Set(output.speakers.map((speaker) => speaker.label));
  let lastSequence = -1;
  for (const utterance of output.utterances) {
    if (!speakers.has(utterance.speaker)) throw new Error("Utterance odkazuje na neznámý hlas.");
    if (utterance.end <= utterance.start) throw new Error("Utterance má neplatný časový rozsah.");
    if ((utterance.playbackStart ?? utterance.start) > output.durationSeconds + 2) {
      throw new Error("Čas přehrávání přesahuje délku audia.");
    }
    if (utterance.end > output.durationSeconds + 2) {
      throw new Error("Utterance přesahuje délku audia.");
    }
    if (utterance.sequence <= lastSequence) throw new Error("Pořadí utterances není vzestupné.");
    lastSequence = utterance.sequence;
  }
  return output;
}

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  podcastId: uuidSchema,
  episodeId: uuidSchema.optional(),
  personId: uuidSchema.optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  mode: z.enum(["fulltext", "semantic", "hybrid"]).default("hybrid"),
  precision: z.enum(["strict", "balanced", "related"]).default("balanced"),
});
