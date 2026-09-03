import type { EpisodeStatus } from "./entities.ts";
import { DomainError } from "./errors.ts";

const transitions: Readonly<Record<EpisodeStatus, readonly EpisodeStatus[]>> = {
  new: ["imported", "failed"],
  imported: ["download_queued", "failed"],
  download_queued: ["downloading", "failed"],
  downloading: ["downloaded", "download_queued", "failed"],
  downloaded: ["normalization_queued", "failed"],
  normalization_queued: ["normalizing", "failed"],
  normalizing: ["normalized", "normalization_queued", "failed"],
  normalized: ["transcription_queued", "failed"],
  transcription_queued: ["transcribing", "failed"],
  transcribing: ["transcribed", "transcription_queued", "failed"],
  transcribed: ["speaker_identification_pending", "indexing_queued", "failed"],
  speaker_identification_pending: ["indexing_queued", "failed"],
  indexing_queued: ["indexing", "failed"],
  indexing: ["ready", "indexing_queued", "failed"],
  ready: ["download_queued", "transcription_queued", "indexing_queued", "failed"],
  failed: [
    "download_queued",
    "normalization_queued",
    "transcription_queued",
    "indexing_queued",
  ],
};

export function canTransition(from: EpisodeStatus, to: EpisodeStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: EpisodeStatus, to: EpisodeStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      `Neplatný přechod stavu epizody: ${from} → ${to}.`,
      "INVALID_EPISODE_TRANSITION",
      409,
    );
  }
}
