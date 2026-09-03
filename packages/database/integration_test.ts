import { assert, assertEquals } from "@std/assert";
import { createDatabase } from "./client.ts";
import { loadConfig } from "../shared/config.ts";
import { JobRepository } from "./repositories/jobs.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: dva workery neclaimnou stejný job",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const repository = new JobRepository(sql);
    const entityId = crypto.randomUUID();
    try {
      await repository.enqueue("DOWNLOAD_AUDIO", "episode", entityId);
      const claimed = await Promise.all([
        repository.claim("integration-worker-a", 1800),
        repository.claim("integration-worker-b", 1800),
      ]);
      assertEquals(claimed.filter(Boolean).length, 1);
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ${entityId}`;
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: aktivní doba úlohy vynechá frontu a čekací fáze",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const repository = new JobRepository(sql);
    const entityId = crypto.randomUUID();
    try {
      const jobId = await repository.enqueue("PROCESS_AUDIO_ML", "episode", entityId);
      await sql`UPDATE jobs SET created_at = now() - interval '1 hour' WHERE id = ${jobId}`;
      const claimed = await repository.claim("duration-test-worker", 1800);
      if (!claimed) throw new Error("Testovací úloha nebyla převzata.");

      await sql`UPDATE jobs SET active_started_at = now() - interval '10 seconds'
        WHERE id = ${jobId}`;
      await repository.updateProgress(jobId, "duration-test-worker", {
        phase: "waiting_for_slot",
        message: "Čekám na slot.",
      });
      const waiting = await sql`
        SELECT active_started_at, processing_duration_ms FROM jobs WHERE id = ${jobId}
      `;
      assertEquals(waiting[0]?.activeStartedAt, null);
      assert(Number(waiting[0]?.processingDurationMs) >= 9_900);
      assert(Number(waiting[0]?.processingDurationMs) < 10_500);

      await repository.updateProgress(jobId, "duration-test-worker", {
        phase: "transcription",
        current: 0,
        total: 1,
        message: "Přepisuji.",
      });
      await sql`UPDATE jobs SET active_started_at = now() - interval '5 seconds'
        WHERE id = ${jobId}`;
      await repository.complete(jobId, "duration-test-worker");
      const completed = await sql`
        SELECT active_started_at, processing_duration_ms,
          extract(epoch FROM (started_at - created_at)) AS queue_seconds
        FROM jobs WHERE id = ${jobId}
      `;
      assertEquals(completed[0]?.activeStartedAt, null);
      assert(Number(completed[0]?.processingDurationMs) >= 14_900);
      assert(Number(completed[0]?.processingDurationMs) < 15_500);
      assert(Number(completed[0]?.queueSeconds) > 3_500);
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ${entityId}`;
      await sql.end();
    }
  },
});
