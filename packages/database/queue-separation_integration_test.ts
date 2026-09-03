import { assertEquals } from "@std/assert";
import { downloadJobTypes, processingJobTypes } from "../domain/job-types.ts";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { JobRepository } from "./repositories/jobs.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: download a processing workery claimují pouze svou frontu",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const repository = new JobRepository(sql);
    const downloadEntityId = crypto.randomUUID();
    const processingEntityId = crypto.randomUUID();
    try {
      await repository.enqueue("DOWNLOAD_AUDIO", "episode", downloadEntityId, {}, 1_000_000);
      await repository.enqueue("NORMALIZE_AUDIO", "episode", processingEntityId, {}, 1_000_000);
      const [download, processing] = await Promise.all([
        repository.claim("download-queue-worker", 1800, downloadJobTypes),
        repository.claim("processing-queue-worker", 1800, processingJobTypes),
      ]);
      assertEquals(download?.type, "DOWNLOAD_AUDIO");
      assertEquals(download?.entityId, downloadEntityId);
      assertEquals(processing?.type, "NORMALIZE_AUDIO");
      assertEquals(processing?.entityId, processingEntityId);
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id IN (${downloadEntityId}, ${processingEntityId})`;
      await sql.end();
    }
  },
});
