import { createDatabase } from "../packages/database/client.ts";
import { loadConfig } from "../packages/shared/config.ts";

const sql = createDatabase(loadConfig());
try {
  await sql.begin(async (tx) => {
    const podcastRows = await tx`
      INSERT INTO podcasts (
        name, rss_url, website_url, description, last_imported_at
      ) VALUES (
        '[DEMO] Podcast Intelligence', 'https://demo.invalid/podcast.xml',
        'https://demo.invalid', 'Lokální ukázková data – nejde o skutečně zpracovaný podcast.',
        now()
      )
      ON CONFLICT (rss_url) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    const podcastId = String(podcastRows[0]?.id);
    const episodeRows = await tx`
      INSERT INTO episodes (
        podcast_id, external_id, title, description, published_at, audio_url,
        duration_seconds, processing_status
      ) VALUES (
        ${podcastId}, 'demo-episode-1', '[DEMO] Budoucnost městské dopravy',
        'Syntetická ukázka dat pro ověření UI a fulltextu.',
        '2025-01-15T10:00:00Z', 'https://demo.invalid/audio.mp3', 180, 'transcribed'
      )
      ON CONFLICT (podcast_id, external_id) DO UPDATE SET title = EXCLUDED.title
      RETURNING id, active_processing_run_id
    `;
    const episodeId = String(episodeRows[0]?.id);
    if (episodeRows[0]?.activeProcessingRunId) {
      console.log("Demo data už existují; seed je beze změny.");
      return;
    }

    async function person(displayName: string, regular: boolean): Promise<string> {
      const normalized = displayName.toLocaleLowerCase("cs");
      const existing = await tx`
        SELECT id FROM persons WHERE normalized_name = ${normalized} ORDER BY created_at LIMIT 1
      `;
      if (existing[0]) return String(existing[0].id);
      const rows = await tx`
        INSERT INTO persons (display_name, normalized_name, description, is_regular_host)
        VALUES (
          ${displayName}, ${normalized}, 'Syntetická demo osoba.', ${regular}
        ) RETURNING id
      `;
      return String(rows[0]?.id);
    }

    const moderatorId = await person("Demo Moderátorka", true);
    const guestId = await person("Demo Host", false);
    await tx`
      INSERT INTO podcast_persons (podcast_id, person_id, role)
      VALUES (${podcastId}, ${moderatorId}, 'moderator'),
        (${podcastId}, ${guestId}, 'guest')
      ON CONFLICT (podcast_id, person_id)
      DO UPDATE SET role = EXCLUDED.role, updated_at = now()
    `;
    await tx`
      INSERT INTO episode_participants (episode_id, person_id, role, source, confidence)
      VALUES (${episodeId}, ${moderatorId}, 'moderator', 'manual', 1),
        (${episodeId}, ${guestId}, 'guest', 'manual', 1)
      ON CONFLICT DO NOTHING
    `;
    const runRows = await tx`
      INSERT INTO processing_runs (
        episode_id, status, pipeline_version, transcription_model,
        diarization_model, speaker_embedding_model, completed_at
      ) VALUES (
        ${episodeId}, 'completed', 'demo-fixture', 'demo-not-a-model',
        'demo-not-a-model', 'demo-not-a-model', now()
      ) RETURNING id
    `;
    const runId = String(runRows[0]?.id);
    const clusterRows = await tx`
      INSERT INTO speaker_clusters (
        episode_id, processing_run_id, local_label, total_speech_seconds,
        segment_count, representative_start_seconds, representative_end_seconds,
        assigned_person_id, identity_confidence, identity_status, identity_source
      ) VALUES
        (${episodeId}, ${runId}, 'SPEAKER_00', 40, 2, 5, 20,
          ${moderatorId}, 1, 'verified', 'manual'),
        (${episodeId}, ${runId}, 'SPEAKER_01', 92, 3, 21, 55,
          ${guestId}, 1, 'verified', 'manual')
      RETURNING id, local_label
    `;
    const clusters = new Map(clusterRows.map((row) => [String(row.localLabel), String(row.id)]));
    const utteranceRows = await tx`
      INSERT INTO utterances (
        episode_id, processing_run_id, speaker_cluster_id, person_id,
        sequence_number, start_seconds, end_seconds, text,
        transcription_confidence, speaker_confidence, language
      ) VALUES
        (${episodeId}, ${runId}, ${clusters.get("SPEAKER_00")}, ${moderatorId},
          0, 5, 20, 'Jak podle vás elektromobilita změní dopravu ve městech?',
          0.99, 0.99, 'cs'),
        (${episodeId}, ${runId}, ${clusters.get("SPEAKER_01")}, ${guestId},
          1, 21, 55, 'Elektromobilita pomůže hlavně tehdy, když ji spojíme s veřejnou dopravou a sdílenými auty.',
          0.98, 0.98, 'cs'),
        (${episodeId}, ${runId}, ${clusters.get("SPEAKER_00")}, ${moderatorId},
          2, 56, 70, 'Co považujete za největší překážku?',
          0.99, 0.99, 'cs'),
        (${episodeId}, ${runId}, ${clusters.get("SPEAKER_01")}, ${guestId},
          3, 71, 118, 'Největší překážkou není dojezd, ale pomalé povolování nabíjecí infrastruktury.',
          0.98, 0.98, 'cs')
      RETURNING id, sequence_number
    `;
    const chunkRows = await tx`
      INSERT INTO content_chunks (
        episode_id, processing_run_id, start_seconds, end_seconds, text, token_count
      ) VALUES (
        ${episodeId}, ${runId}, 5, 118,
        'Jak podle vás elektromobilita změní dopravu ve městech?
Elektromobilita pomůže hlavně tehdy, když ji spojíme s veřejnou dopravou a sdílenými auty.
Co považujete za největší překážku?
Největší překážkou není dojezd, ale pomalé povolování nabíjecí infrastruktury.',
        62
      ) RETURNING id
    `;
    const chunkId = String(chunkRows[0]?.id);
    for (const row of utteranceRows) {
      await tx`
        INSERT INTO content_chunk_utterances (content_chunk_id, utterance_id, position)
        VALUES (${chunkId}, ${row.id}, ${row.sequenceNumber})
      `;
    }
    await tx`
      UPDATE episodes SET active_processing_run_id = ${runId}, processing_status = 'ready'
      WHERE id = ${episodeId}
    `;
    console.log("Demo data byla vytvořena.");
  });
} finally {
  await sql.end();
}
