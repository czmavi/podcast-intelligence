import { assertEquals, assertStringIncludes } from "@std/assert";
import { jobDurationHtml, jobDurationView } from "./jobs.ts";

Deno.test("doba úlohy sčítá uloženou práci a právě aktivní úsek", () => {
  const view = jobDurationView({
    status: "running",
    attempts: 2,
    processingDurationMs: 30_000,
    activeStartedAt: "2026-08-22T10:00:00.000Z",
  }, new Date("2026-08-22T10:02:00.000Z"));
  assertEquals(view, { durationMs: 150_000, label: "Aktivně", ticking: true });
});

Deno.test("čekající úloha bez aktivního úseku čas nenavyšuje", () => {
  const waiting = {
    status: "running",
    attempts: 1,
    processingDurationMs: 42_000,
    activeStartedAt: null,
  };
  assertEquals(jobDurationView(waiting, new Date("2026-08-22T10:00:00.000Z")), {
    durationMs: 42_000,
    label: "Aktivně",
    ticking: false,
  });
  assertStringIncludes(jobDurationHtml(waiting), "Aktivně 00:00:42");
  assertEquals(jobDurationHtml({ status: "queued", attempts: 0 }), "—");
});
