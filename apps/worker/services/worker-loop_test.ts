import { assertEquals } from "@std/assert";
import type { Job } from "../../../packages/domain/job-types.ts";
import { runWorkerLoop, type WorkerLoopFailure } from "./worker-loop.ts";

function job(id: string): Job {
  return {
    id,
    type: "DOWNLOAD_AUDIO",
    entityType: "episode",
    entityId: id,
    status: "running",
    priority: 0,
    attempts: 1,
    maxAttempts: 3,
    payload: {},
  };
}

Deno.test("worker přežije výpadek claimu a po obnovení databáze zpracuje úlohu", async () => {
  let claims = 0;
  let stopping = false;
  const processed: string[] = [];
  const waits: number[] = [];
  const failures: WorkerLoopFailure[] = [];
  await runWorkerLoop({
    claim: () => {
      claims++;
      if (claims <= 2) return Promise.reject(new Error("write CONNECTION_CLOSED postgres:5432"));
      return Promise.resolve(job("recovered"));
    },
    process: (claimed) => {
      processed.push(claimed.id);
      stopping = true;
      return Promise.resolve();
    },
    shouldStop: () => stopping,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    pollIntervalMs: 2000,
    onError: (_error, failure) => failures.push(failure),
  });
  assertEquals(claims, 3);
  assertEquals(processed, ["recovered"]);
  assertEquals(waits, [2000, 4000]);
  assertEquals(failures.map((failure) => failure.jobId), [null, null]);
});

Deno.test("worker po selhání uložení výsledku neopakuje handler bez nového claimu", async () => {
  let claims = 0;
  let stopping = false;
  const processed: string[] = [];
  const failures: WorkerLoopFailure[] = [];
  const waits: number[] = [];
  await runWorkerLoop({
    claim: () => {
      claims++;
      // The failed job remains leased in the database, so it is not available for retry yet.
      return Promise.resolve(claims === 1 ? job("leased") : claims === 2 ? null : job("next"));
    },
    process: async (claimed) => {
      processed.push(claimed.id);
      if (claimed.id === "leased") {
        try {
          await Promise.reject(new Error("complete: CONNECTION_CLOSED"));
        } catch {
          await Promise.reject(new Error("fail: CONNECTION_CLOSED"));
        }
      }
      stopping = true;
    },
    shouldStop: () => stopping,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    pollIntervalMs: 2000,
    onError: (_error, failure) => failures.push(failure),
  });
  assertEquals(processed, ["leased", "next"]);
  assertEquals(claims, 3);
  assertEquals(waits, [2000, 2000]);
  assertEquals(failures, [{ jobId: "leased", consecutiveFailures: 1, retryInMs: 2000 }]);
});

Deno.test("worker omezuje backoff a po úspěšném dotazu jej resetuje", async () => {
  let claims = 0;
  let stopping = false;
  const waits: number[] = [];
  await runWorkerLoop({
    claim: () => {
      claims++;
      if (claims <= 6 || claims === 8) return Promise.reject(new Error("database unavailable"));
      return Promise.resolve(claims === 7 ? null : job("recovered"));
    },
    process: () => {
      stopping = true;
      return Promise.resolve();
    },
    shouldStop: () => stopping,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    pollIntervalMs: 2000,
    onError: () => {},
  });
  assertEquals(waits, [2000, 4000, 8000, 16000, 30000, 30000, 2000, 2000]);
});

Deno.test("worker při ukončení během backoffu už neclaimuje další úlohu", async () => {
  let claims = 0;
  let stopping = false;
  const failures: WorkerLoopFailure[] = [];
  await runWorkerLoop({
    claim: () => {
      claims++;
      return Promise.reject(new Error("database unavailable"));
    },
    process: () => Promise.reject(new Error("No job should be processed")),
    shouldStop: () => stopping,
    wait: () => {
      stopping = true;
      return Promise.resolve();
    },
    pollIntervalMs: 100,
    onError: (_error, failure) => failures.push(failure),
  });
  assertEquals(claims, 1);
  assertEquals(failures[0]?.retryInMs, 1000);
});

Deno.test("výpadek jednoho worker slotu nepřeruší práci jiného slotu", async () => {
  const order: string[] = [];
  let releaseRetry: () => void = () => {};
  const retry = new Promise<void>((resolve) => releaseRetry = resolve);
  let failedSlotStopping = false;
  let healthySlotStopping = false;
  await Promise.all([
    runWorkerLoop({
      claim: () => Promise.reject(new Error("CONNECTION_CLOSED")),
      process: () => Promise.resolve(),
      shouldStop: () => failedSlotStopping,
      wait: () => retry,
      pollIntervalMs: 2000,
      onError: () => order.push("retry"),
    }),
    runWorkerLoop({
      claim: () => Promise.resolve(job("healthy")),
      process: () => {
        order.push("completed");
        healthySlotStopping = true;
        failedSlotStopping = true;
        releaseRetry();
        return Promise.resolve();
      },
      shouldStop: () => healthySlotStopping,
      wait: () => Promise.resolve(),
      pollIntervalMs: 2000,
      onError: () => order.push("unexpected"),
    }),
  ]);
  assertEquals(order, ["retry", "completed"]);
});
