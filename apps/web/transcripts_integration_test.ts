import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createDatabase } from "../../packages/database/client.ts";
import { loadConfig } from "../../packages/shared/config.ts";

Deno.test({
  name: "integration: web zobrazí modely, porovná přepisy a vybere variantu přes API",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    const runs = [crypto.randomUUID(), crypto.randomUUID()];
    const socket = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${socket.addr.port}`;
    socket.close();
    const server = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fromFileUrl(new URL("./main.ts", import.meta.url))],
      env: { APP_ENV: "test", APP_BASE_URL: base, AUTH_MODE: "disabled", ELEVENLABS_API_KEY: "" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = server.output();
    const request = async (path: string, body?: unknown) =>
      await fetch(
        base + path,
        body === undefined ? {} : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const health = await request("/health");
          await health.body?.cancel();
          if (health.ok) break;
        } catch { /* Server is starting. */ }
        if (attempt === 99) throw new Error("Testovací web se nespustil.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await sql`INSERT INTO podcasts(id, name, rss_url) VALUES (${podcastId}, 'Web test', ${`https://example.test/${podcastId}`})`;
      await sql`INSERT INTO episodes(id, podcast_id, external_id, title, audio_url, original_audio_path, normalized_audio_path, transcript_selection_pending)
        VALUES (${episodeId}, ${podcastId}, 'web', 'Porovnání test', 'https://example.test/audio', '/test/audio', '/test/normalized', true)`;
      for (const [index, runId] of runs.entries()) {
        await sql`INSERT INTO processing_runs(id, episode_id, status, pipeline_version, transcription_provider, transcription_model, diarization_model)
          VALUES (${runId}, ${episodeId}, 'completed', '3', ${index ? "elevenlabs" : "local"}, ${
          index ? "scribe_v2" : "Cem13/whisper-large-v3-czech"
        }, ${index ? "scribe_v2-diarization" : "pyannote"})`;
        const cluster =
          (await sql`INSERT INTO speaker_clusters(episode_id, processing_run_id, local_label)
          VALUES (${episodeId}, ${runId}, 'SPEAKER_00') RETURNING id`)[0];
        await sql`INSERT INTO utterances(episode_id, processing_run_id, speaker_cluster_id, sequence_number, start_seconds, end_seconds, text)
          VALUES (${episodeId}, ${runId}, ${cluster?.id}, 0, 0, 5, ${
          index ? "Scribe test" : "Whisper test"
        })`;
      }
      for (
        const path of [
          `/podcasts/${podcastId}`,
          `/episodes/${episodeId}`,
          `/episodes/${episodeId}/transcripts?left=${runs[0]}&right=${runs[1]}`,
        ]
      ) {
        const response = await request(path);
        const text = await response.text();
        assertEquals(response.status, 200, text);
        if (path.includes("/transcripts?")) {
          assertStringIncludes(text, "Whisper test");
          assertStringIncludes(text, "Scribe test");
          assertStringIncludes(text, "Cem13/whisper-large-v3-czech");
        }
        if (path === `/episodes/${episodeId}`) {
          assertStringIncludes(text, "Nejdříve vyberte variantu");
        }
      }
      const unavailable = await request(`/api/episodes/${episodeId}/transcripts`, {
        provider: "elevenlabs",
      });
      assertEquals(unavailable.status, 409);
      await unavailable.body?.cancel();
      const selected = await request(`/api/episodes/${episodeId}/transcripts/select`, {
        runId: runs[1],
      });
      assertEquals(selected.status, 202, await selected.text());
      const detail = await request(`/episodes/${episodeId}`);
      const detailText = await detail.text();
      assertEquals(detail.status, 200, detailText);
      assertStringIncludes(detailText, "Vybraný přepis");
      assertStringIncludes(detailText, "Scribe test");
      assertStringIncludes(detailText, "Hlasová reference není pro tuto variantu dostupná");
    } finally {
      server.kill("SIGTERM");
      await output;
      await sql`DELETE FROM jobs WHERE entity_id = ${episodeId}`;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
