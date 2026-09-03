export const episodeStatuses = [
  "new",
  "imported",
  "download_queued",
  "downloading",
  "downloaded",
  "normalization_queued",
  "normalizing",
  "normalized",
  "transcription_queued",
  "transcribing",
  "transcribed",
  "speaker_identification_pending",
  "indexing_queued",
  "indexing",
  "ready",
  "failed",
] as const;

export type EpisodeStatus = (typeof episodeStatuses)[number];

export interface Podcast {
  id: string;
  name: string;
  rssUrl: string;
  websiteUrl: string | null;
  description: string | null;
  imageUrl: string | null;
  lastImportedAt: string | null;
  transcriptAlignmentMode: "segment" | "overlap" | "overlap_asr_corrected";
}

export interface Episode {
  id: string;
  podcastId: string;
  externalId: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  audioUrl: string;
  sourceUrl: string | null;
  durationSeconds: number | null;
  processingStatus: EpisodeStatus;
  processingError: string | null;
  originalAudioPath: string | null;
  normalizedAudioPath: string | null;
}

export interface UtteranceInput {
  sequence: number;
  start: number;
  end: number;
  playbackStart?: number;
  speaker: string;
  text: string;
  transcriptionConfidence: number | null;
  speakerConfidence: number | null;
  overlapDetected: boolean;
}
