import { assertEquals, assertRejects } from "@std/assert";
import { createDatabase } from "./client.ts";
import { loadConfig } from "../shared/config.ts";
import { saveProcessingResult } from "./repositories/processing.ts";
import { listTranscripts, scheduleTranscript, selectTranscript } from "./transcripts.ts";
import { assignSpeaker } from "./speaker-assignment.ts";
import { scheduleNextAutoProcessEpisode } from "./episode-processing.ts";
import { scribeProcessingResult } from "../../apps/worker/services/elevenlabs.ts";

Deno.test({
  name: "integration: varianty mají vlastní hlasy, výběr je atomický a zachová původní přiřazení",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    const otherEpisodeId = crypto.randomUUID();
    const path = await Deno.makeTempFile();
    let personId: string | undefined;
    const result = (count: number) =>
      scribeProcessingResult(
        {
          language_code: "cs",
          text: "Test",
          words: Array.from(
            { length: count },
            (_, i) => ({
              type: "word",
              text: `Hlas ${i}`,
              start: i * 2,
              end: i * 2 + 1,
              speaker_id: `speaker_${i}`,
            }),
          ),
        },
        episodeId,
        "scribe_v2",
        20,
      );
    try {
      await sql`INSERT INTO podcasts (id, name, rss_url, auto_process_enabled)
        VALUES (${podcastId}, 'Varianty', ${`https://example.test/${podcastId}`}, true)`;
      for (const id of [episodeId, otherEpisodeId]) {
        await sql`INSERT INTO episodes (id, podcast_id, external_id, title, audio_url, original_audio_path, normalized_audio_path, processing_status)
          VALUES (${id}, ${podcastId}, ${id}, 'Test', 'https://example.test/a.mp3', '/original', '/normalized', 'ready')`;
      }
      const firstJob = (await sql`INSERT INTO jobs(type, entity_type, entity_id, status)
        VALUES ('PROCESS_AUDIO_ML', 'episode', ${episodeId}, 'completed') RETURNING id`)[0];
      const firstRun = await saveProcessingResult(sql, result(2), path, String(firstJob?.id));
      const cluster =
        (await sql`SELECT id FROM speaker_clusters WHERE processing_run_id = ${firstRun} ORDER BY local_label`)[
          0
        ];
      const assignment = await assignSpeaker(sql, String(cluster?.id), {
        assignmentType: "newGuest",
        displayName: "Testovací host",
        verified: true,
        createReferenceEmbeddings: false,
        overwrite: false,
      });
      personId = assignment.personId;
      const nextJob = await scheduleTranscript(sql, episodeId, {
        provider: "elevenlabs",
        transcriptAlignmentMode: "segment",
      }, 3);
      await assertRejects(
        () =>
          scheduleTranscript(sql, episodeId, {
            provider: "local",
            transcriptAlignmentMode: "overlap",
          }, 3),
        Error,
        "již běží",
      );
      const options = { candidate: true, provider: "elevenlabs" as const };
      const [secondRun, duplicateRun] = await Promise.all([
        saveProcessingResult(sql, result(3), path, nextJob.jobId, options),
        saveProcessingResult(sql, result(3), path, nextJob.jobId, options),
      ]);
      assertEquals(duplicateRun, secondRun);
      assertEquals((await listTranscripts(sql, episodeId)).map((run) => run.speakerCount).sort(), [
        2,
        3,
      ]);
      assertEquals(
        (await sql`SELECT active_processing_run_id FROM episodes WHERE id = ${episodeId}`)[0]
          ?.activeProcessingRunId,
        firstRun,
      );
      await assertRejects(
        () => selectTranscript(sql, episodeId, secondRun, 3),
        Error,
        "dokončení úloh",
      );
      await assertRejects(
        () =>
          assignSpeaker(sql, String(cluster?.id), {
            assignmentType: "guest",
            personId: personId!,
            verified: true,
            createReferenceEmbeddings: false,
            overwrite: false,
          }),
        Error,
        "Nejdříve vyberte",
      );
      await sql`UPDATE jobs SET status = 'completed' WHERE id = ${nextJob.jobId}`;
      assertEquals(await scheduleNextAutoProcessEpisode(sql, 3), null);
      await assertRejects(() => selectTranscript(sql, otherEpisodeId, secondRun, 3), Error);
      const selected = await selectTranscript(sql, episodeId, secondRun, 3);
      assertEquals(
        (await sql`SELECT active_processing_run_id, transcript_selection_pending FROM episodes WHERE id = ${episodeId}`)[
          0
        ],
        {
          activeProcessingRunId: secondRun,
          transcriptSelectionPending: false,
        },
      );
      assertEquals(await selectTranscript(sql, episodeId, secondRun, 3), {
        runId: secondRun,
        jobId: null,
      });
      const payload = (await sql`SELECT type, payload FROM jobs WHERE id = ${selected.jobId}`)[0];
      assertEquals(payload?.type, "IDENTIFY_SPEAKERS");
      assertEquals(payload?.payload, { processingRunId: secondRun });
      await assertRejects(
        () =>
          assignSpeaker(sql, String(cluster?.id), {
            assignmentType: "guest",
            personId: personId!,
            verified: true,
            createReferenceEmbeddings: false,
            overwrite: false,
          }),
        Error,
        "Nejdříve vyberte",
      );
      await sql`UPDATE jobs SET status = 'completed' WHERE id = ${selected.jobId}`;
      await selectTranscript(sql, episodeId, firstRun, 3);
      assertEquals(
        (await sql`SELECT assigned_person_id FROM speaker_clusters WHERE id = ${cluster?.id}`)[0]
          ?.assignedPersonId,
        personId,
      );
      assertEquals(
        (await sql`SELECT count(*)::int AS total FROM speaker_clusters WHERE processing_run_id = ${secondRun}`)[
          0
        ]?.total,
        3,
      );
    } finally {
      await sql`DELETE FROM jobs WHERE entity_id IN (${episodeId}, ${otherEpisodeId})`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      if (personId) await sql`DELETE FROM persons WHERE id = ${personId}`;
      await sql.end({ timeout: 5 });
      await Deno.remove(path);
    }
  },
});
