import { assertEquals } from "@std/assert";
import { createDatabase } from "../database/client.ts";
import { updateEpisodeRagExclusion } from "../database/episode-rag.ts";
import { searchFilterOptions } from "../database/search-filters.ts";
import { loadConfig } from "../shared/config.ts";
import { episodeStorage } from "../shared/paths.ts";
import type { TextEmbeddingProvider } from "./providers.ts";
import { search } from "./search.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

const provider: TextEmbeddingProvider = {
  modelName: "integration-model",
  dimensions: 1,
  candidateLimit: 10,
  minRerankScore: 0.2,
  embedDocuments: () => Promise.resolve([[0]]),
  embedQuery: () => Promise.resolve([0]),
  rerank: (_query, documents) => Promise.resolve(documents.map(() => 1)),
};

Deno.test({
  name: "integration: vyhledávání filtruje kontext a respektuje RAG exclusion",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    const processingRunId = crypto.randomUUID();
    const speakerClusterId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const storageRoot = await Deno.makeTempDir({ prefix: "podcast-rag-exclusion-" });
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'RAG exclusion test', ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, audio_url, processing_status
        ) VALUES (
          ${episodeId}, ${podcastId}, 'rag-exclusion', 'RAG exclusion',
          'https://example.test/audio.mp3', 'ready'
        )
      `;
      await sql`
        INSERT INTO processing_runs (id, episode_id, status, pipeline_version, completed_at)
        VALUES (${processingRunId}, ${episodeId}, 'completed', 'integration', now())
      `;
      await sql`
        INSERT INTO persons (id, display_name, normalized_name)
        VALUES (${personId}, 'RAG Test Speaker', 'rag test speaker')
      `;
      await sql`
        UPDATE episodes SET active_processing_run_id = ${processingRunId} WHERE id = ${episodeId}
      `;
      await sql`
        INSERT INTO speaker_clusters (
          id, episode_id, processing_run_id, local_label, total_speech_seconds, segment_count,
          assigned_person_id, identity_status
        ) VALUES (
          ${speakerClusterId}, ${episodeId}, ${processingRunId}, 'SPEAKER_00', 10, 1,
          ${personId}, 'verified'
        )
      `;
      await sql`
        INSERT INTO utterances (
          episode_id, processing_run_id, speaker_cluster_id, sequence_number,
          start_seconds, end_seconds, text, person_id
        ) VALUES (
          ${episodeId}, ${processingRunId}, ${speakerClusterId}, 0, 0, 10,
          'ragexclusiontoken Martin Vohánka',
          ${personId}
        )
      `;
      const chunks = await sql`
        INSERT INTO content_chunks (
          episode_id, processing_run_id, start_seconds, end_seconds, text, token_count
        ) VALUES (
          ${episodeId}, ${processingRunId}, 0, 10, 'ragexclusiontoken Martin Vohánka', 3
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO content_chunk_utterances (content_chunk_id, utterance_id, position)
        SELECT ${chunks[0]?.id}, id, 0
        FROM utterances
        WHERE episode_id = ${episodeId} AND processing_run_id = ${processingRunId}
      `;
      const paths = episodeStorage(storageRoot, podcastId, episodeId);
      await Deno.mkdir(paths.derived, { recursive: true });
      const transcriptPath = `${paths.derived}/transcript-integration.json`;
      await Deno.writeTextFile(transcriptPath, "{}");
      await sql`
        INSERT INTO processing_artifacts (
          episode_id, processing_run_id, artifact_type, storage_path, mime_type
        ) VALUES (
          ${episodeId}, ${processingRunId}, 'transcript_json', ${transcriptPath},
          'application/json'
        )
      `;

      const input = {
        query: "ragexclusiontoken",
        podcastId,
        limit: 10,
        mode: "fulltext" as const,
        precision: "balanced" as const,
      };
      assertEquals((await search(sql, input, provider)).length, 1);
      const focusedResults = await search(
        sql,
        {
          ...input,
          query: "Martinu Voháňkovi",
          personId,
        },
        provider,
        { lexicalMatch: "all" },
      );
      assertEquals(focusedResults.length, 1);
      assertEquals(focusedResults[0]?.text, "ragexclusiontoken Martin Vohánka");
      assertEquals(
        await search(sql, { ...input, episodeId: crypto.randomUUID() }, provider),
        [],
      );
      const filters = await searchFilterOptions(sql, podcastId, episodeId);
      assertEquals(filters.episodes.map((episode) => episode.id), [episodeId]);
      assertEquals(filters.people, [{ id: personId, label: "RAG Test Speaker" }]);

      const exclusion = await updateEpisodeRagExclusion(sql, storageRoot, episodeId, true);
      assertEquals(exclusion.deletedTranscriptFiles, 1);
      assertEquals(await search(sql, input, provider), []);
      const deleted = await sql`
        SELECT episode.rag_excluded, episode.active_processing_run_id,
          (SELECT count(*)::int FROM processing_runs WHERE episode_id = ${episodeId}) AS runs,
          (SELECT count(*)::int FROM speaker_clusters WHERE episode_id = ${episodeId}) AS speakers,
          (SELECT count(*)::int FROM utterances WHERE episode_id = ${episodeId}) AS utterances,
          (SELECT count(*)::int FROM content_chunks WHERE episode_id = ${episodeId}) AS chunks
        FROM episodes episode WHERE episode.id = ${episodeId}
      `;
      assertEquals(deleted[0], {
        ragExcluded: true,
        activeProcessingRunId: null,
        runs: 0,
        speakers: 0,
        utterances: 0,
        chunks: 0,
      });
      assertEquals(await searchFilterOptions(sql, podcastId), { episodes: [], people: [] });
      await updateEpisodeRagExclusion(sql, storageRoot, episodeId, false);
      assertEquals(await search(sql, input, provider), []);
    } finally {
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql`DELETE FROM persons WHERE id = ${personId}`;
      await sql.end({ timeout: 5 });
      await Deno.remove(storageRoot, { recursive: true });
    }
  },
});
