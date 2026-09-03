export const DEFAULT_EPISODE_PROCESSING_ESTIMATE_MS = 60 * 60 * 1000;

export interface AutomationDurationEstimate {
  averageEpisodeDurationMs: number;
  estimatedRemainingMs: number;
  sampleCount: number;
  source: "history" | "fallback";
}

export function estimateAutomationDuration(
  durationValues: readonly unknown[],
  remainingCountValue: unknown,
): AutomationDurationEstimate {
  const durations = durationValues.map(Number).filter((duration) =>
    Number.isFinite(duration) && duration > 0
  ).slice(0, 5);
  const remainingCount = Math.max(0, Math.floor(Number(remainingCountValue) || 0));
  const averageEpisodeDurationMs = durations.length > 0
    ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
    : DEFAULT_EPISODE_PROCESSING_ESTIMATE_MS;
  return {
    averageEpisodeDurationMs,
    estimatedRemainingMs: averageEpisodeDurationMs * remainingCount,
    sampleCount: durations.length,
    source: durations.length > 0 ? "history" : "fallback",
  };
}
