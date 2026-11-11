import { assertEquals } from "@std/assert";
import type { EpisodeStatus } from "../domain/entities.ts";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { podcastAutomationProgress } from "./podcast-automation.ts";

Deno.test({
  name: "integration: odhad počítá dokončený přepis jako hotový i před výběrem a přiřazením hlasů",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodes = new Map<string, string>();
    const definitions: Array<{
      key: string;
      status: EpisodeStatus;
      run?: "running" | "completed" | "failed";
      pending?: boolean;
      voice?: "unknown" | "ignored";
      excluded?: boolean;
      present?: boolean;
      audio?: boolean;
    }> = [
      { key: "selection", status: "transcribed", run: "completed", pending: true },
      {
        key: "hosts",
        status: "speaker_identification_pending",
        run: "completed",
        voice: "unknown",
      },
      { key: "readyUnknown", status: "ready", run: "completed", voice: "unknown" },
      { key: "indexing", status: "indexing", run: "completed", voice: "ignored" },
      { key: "ready", status: "ready", run: "completed" },
      { key: "failedAfterTranscript", status: "failed", run: "completed" },
      { key: "new", status: "imported" },
      { key: "transcribing", status: "transcribing", run: "running" },
      { key: "failed", status: "failed", run: "failed" },
      { key: "unavailable", status: "imported", present: false },
      { key: "excluded", status: "imported", run: "completed", excluded: true },
      { key: "offlineAudio", status: "downloaded", present: false, audio: true },
      { key: "missingResult", status: "transcribed" },
    ];
    try {
      await sql`INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Automation', ${`https://example.test/${podcastId}`})`;
      for (const definition of definitions) {
        const episodeId = crypto.randomUUID();
        episodes.set(definition.key, episodeId);
        await sql`INSERT INTO episodes (id, podcast_id, external_id, title, audio_url,
          processing_status, transcript_selection_pending, rag_excluded, is_present_in_feed, original_audio_path)
          VALUES (${episodeId}, ${podcastId}, ${definition.key}, ${definition.key}, 'https://example.test/audio',
            ${definition.status}, ${definition.pending ?? false}, ${definition.excluded ?? false},
            ${definition.present ?? true}, ${definition.audio ? "/audio.mp3" : null})`;
        if (definition.run) {
          const runId = crypto.randomUUID();
          await sql`INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
            VALUES (${runId}, ${episodeId}, ${definition.run}, '3')`;
          if (definition.run === "completed" && !definition.pending) {
            await sql`UPDATE episodes SET active_processing_run_id = ${runId} WHERE id = ${episodeId}`;
          }
          if (definition.voice) {
            await sql`INSERT INTO speaker_clusters (episode_id, processing_run_id, local_label, identity_status)
              VALUES (${episodeId}, ${runId}, 'SPEAKER_00', ${definition.voice})`;
          }
        }
      }
      // Multiple completed variants still represent one processed episode.
      await sql`INSERT INTO processing_runs (episode_id, status, pipeline_version)
        VALUES (${episodes.get("selection")!}, 'completed', '3')`;
      for (
        const [key, type] of [
          ["hosts", "IDENTIFY_SPEAKERS"],
          ["indexing", "CREATE_TEXT_EMBEDDINGS"],
          ["transcribing", "PROCESS_AUDIO_ML"],
        ] as const
      ) {
        await sql`INSERT INTO jobs (type, entity_type, entity_id, status)
          VALUES (${type}, 'episode', ${episodes.get(key)!}, 'queued')`;
      }
      for (
        const [key, type, duration, date] of [
          ["selection", "PROCESS_AUDIO_ML", 500, "2026-10-01T10:00:00Z"],
          ["selection", "PROCESS_AUDIO_ML", 1000, "2026-10-26T10:00:00Z"],
          ["selection", "NORMALIZE_AUDIO", 100, "2026-10-26T09:00:00Z"],
          ["selection", "DOWNLOAD_AUDIO", 10, "2026-10-26T08:00:00Z"],
          ["selection", "IDENTIFY_SPEAKERS", 80_000, "2026-10-26T11:00:00Z"],
          ["selection", "CREATE_TEXT_EMBEDDINGS", 90_000, "2026-10-26T12:00:00Z"],
          ["readyUnknown", "PROCESS_AUDIO_ML", 2000, "2026-10-25T10:00:00Z"],
          ["failedAfterTranscript", "PROCESS_AUDIO_ML", 3000, "2026-10-24T10:00:00Z"],
          ["transcribing", "PROCESS_AUDIO_ML", 4000, "2026-10-26T11:00:00Z"],
          ["excluded", "PROCESS_AUDIO_ML", 5000, "2026-10-26T11:00:00Z"],
        ] as const
      ) {
        await sql`INSERT INTO jobs (type, entity_type, entity_id, status, processing_duration_ms, completed_at)
          VALUES (${type}, 'episode', ${episodes.get(key)!}, 'completed', ${duration}, ${date})`;
      }
      const progress = await podcastAutomationProgress(sql, podcastId);
      assertEquals(progress.counts, {
        totalCount: 13,
        processedCount: 6,
        remainingCount: 4,
        failedCount: 1,
        inProgressCount: 1,
        unavailableCount: 1,
        excludedCount: 1,
        reviewCount: 3,
      });
      assertEquals(progress.durations, [1110, 2000, 3000]);
      await sql`UPDATE episodes SET transcript_selection_pending = false,
        active_processing_run_id = (SELECT id FROM processing_runs WHERE episode_id = episodes.id LIMIT 1)
        WHERE id = ${episodes.get("selection")!}`;
      await sql`UPDATE speaker_clusters SET identity_status = 'ignored'
        WHERE episode_id IN (${episodes.get("hosts")!}, ${episodes.get("readyUnknown")!})`;
      assertEquals(await podcastAutomationProgress(sql, podcastId), {
        ...progress,
        counts: { ...progress.counts, reviewCount: 0 },
      });
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id = ANY(${[...episodes.values()]})`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
