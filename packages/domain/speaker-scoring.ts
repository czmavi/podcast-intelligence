export interface CandidateSignals {
  voiceSimilarities: number[];
  expectedParticipant: boolean;
  regularHost: boolean;
  directAddressScore: number;
}

export interface CandidateScore {
  voiceSimilarity: number;
  metadataScore: number;
  directAddressScore: number;
  combinedScore: number;
  evidence: {
    referenceCount: number;
    aggregation: "median-top-3";
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreSpeakerCandidate(signals: CandidateSignals): CandidateScore {
  const similarities = signals.voiceSimilarities
    .filter(Number.isFinite)
    .map(clamp)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .sort((a, b) => a - b);
  const middle = similarities.length === 0 ? 0 : similarities[Math.floor(similarities.length / 2)]!;
  const metadata = clamp(
    (signals.expectedParticipant ? 0.7 : 0) + (signals.regularHost ? 0.3 : 0),
  );
  const direct = clamp(signals.directAddressScore);
  return {
    voiceSimilarity: middle,
    metadataScore: metadata,
    directAddressScore: direct,
    combinedScore: clamp(middle * 0.72 + metadata * 0.18 + direct * 0.1),
    evidence: {
      referenceCount: similarities.length,
      aggregation: "median-top-3",
    },
  };
}
