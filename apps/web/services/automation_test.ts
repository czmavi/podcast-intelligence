import { assertEquals } from "@std/assert";
import {
  DEFAULT_EPISODE_PROCESSING_ESTIMATE_MS,
  estimateAutomationDuration,
} from "./automation.ts";

Deno.test("odhad automatizace používá průměr nejvýše pěti posledních epizod", () => {
  const estimate = estimateAutomationDuration(
    [30 * 60_000, 90 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000, 10],
    3,
  );
  assertEquals(estimate, {
    averageEpisodeDurationMs: 60 * 60_000,
    estimatedRemainingMs: 3 * 60 * 60_000,
    sampleCount: 5,
    source: "history",
  });
});

Deno.test("odhad automatizace bez historie použije hodinový fallback", () => {
  const estimate = estimateAutomationDuration([0, null, "neplatné"], 2);
  assertEquals(estimate, {
    averageEpisodeDurationMs: DEFAULT_EPISODE_PROCESSING_ESTIMATE_MS,
    estimatedRemainingMs: 2 * DEFAULT_EPISODE_PROCESSING_ESTIMATE_MS,
    sampleCount: 0,
    source: "fallback",
  });
});

Deno.test("nulový backlog má nulový odhad i bez historie", () => {
  assertEquals(estimateAutomationDuration([], 0).estimatedRemainingMs, 0);
});
