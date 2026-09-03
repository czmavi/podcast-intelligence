import { createDatabase } from "../packages/database/client.ts";
import { loadConfig } from "../packages/shared/config.ts";

const config = loadConfig();
const sql = createDatabase(config);

try {
  const episodes = await sql`
    SELECT id FROM episodes
    WHERE active_processing_run_id IS NOT NULL
    ORDER BY published_at NULLS LAST, id
  `;
  for (const episode of episodes) {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO jobs (type, entity_type, entity_id, payload, max_attempts)
        VALUES ('CREATE_CONTENT_CHUNKS', 'episode', ${episode.id}, '{}'::jsonb,
          ${config.MAX_JOB_ATTEMPTS})
        ON CONFLICT (type, entity_id) WHERE status IN ('queued', 'running')
        DO UPDATE SET priority = GREATEST(jobs.priority, EXCLUDED.priority)
      `;
      await tx`
        UPDATE episodes
        SET processing_status = 'indexing_queued', processing_error = NULL, updated_at = now()
        WHERE id = ${episode.id}
      `;
    });
  }
  console.log(`Do fronty bylo zařazeno ${episodes.length} epizod k nové indexaci.`);
} finally {
  await sql.end({ timeout: 10 });
}
