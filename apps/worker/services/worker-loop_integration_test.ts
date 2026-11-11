import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { loadConfig } from "../../../packages/shared/config.ts";
import { runWorkerLoop } from "./worker-loop.ts";

Deno.test({
  name: "integration: worker obnoví odběr po skutečném přerušení databázového spojení",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const config = loadConfig();
    const applicationName = `worker-loop-test-${crypto.randomUUID()}`;
    const sql = postgres(config.DATABASE_URL, {
      max: 1,
      connect_timeout: 2,
      connection: { application_name: applicationName },
    });
    const control = postgres(config.DATABASE_URL, { max: 1, connect_timeout: 2 });
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let claims = 0;
    let processed = 0;
    const failures: unknown[] = [];
    const loop = runWorkerLoop({
      claim: async () => {
        claims++;
        if (claims === 1) await sql`SELECT pg_sleep(30)`;
        else await sql`SELECT 1`;
        return {
          id: "recovered",
          type: "DOWNLOAD_AUDIO",
          entityType: "episode",
          entityId: "recovered",
          status: "running",
          priority: 0,
          attempts: 1,
          maxAttempts: 3,
          payload: {},
        };
      },
      process: () => {
        processed++;
        stopping = true;
        return Promise.resolve();
      },
      shouldStop: () => stopping,
      wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
      pollIntervalMs: 100,
      onError: (error) => failures.push(error),
    });
    try {
      let pid: number | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && pid === undefined) {
        const rows = await control`
          SELECT pid FROM pg_stat_activity
          WHERE application_name = ${applicationName} AND wait_event = 'PgSleep'
        `;
        if (rows[0]) pid = Number(rows[0].pid);
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(pid !== undefined, "Testovací dotaz musí běžet před přerušením spojení.");
      const terminated = await control`SELECT pg_terminate_backend(${pid}) AS terminated`;
      assertEquals(terminated[0]?.terminated, true);
      await Promise.race([
        loop,
        new Promise<never>((_resolve, reject) => {
          recoveryTimer = setTimeout(() => reject(new Error("Worker se neobnovil.")), 10_000);
        }),
      ]);
      assert(claims >= 2);
      assertEquals(processed, 1);
      assert(failures.length >= 1);
    } finally {
      clearTimeout(recoveryTimer);
      stopping = true;
      await sql.end({ timeout: 1 });
      await loop;
      await control.end({ timeout: 1 });
    }
  },
});
