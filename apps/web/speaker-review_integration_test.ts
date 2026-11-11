import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { createDatabase } from "../../packages/database/client.ts";
import { loadConfig } from "../../packages/shared/config.ts";

Deno.test({
  name:
    "integration: přeskočení zachová díl, mění navigaci a filtr; segment ukládá mluvčího přes JSON API",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const currentId = episodes[0]!;
    const skippedId = episodes[1]!;
    const pendingId = episodes[2]!;
    const personId = crypto.randomUUID();
    const foreignPersonId = crypto.randomUUID();
    const utteranceId = crypto.randomUUID();
    const socket = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${socket.addr.port}`;
    socket.close();
    const server = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fromFileUrl(new URL("./main.ts", import.meta.url))],
      env: { APP_ENV: "test", APP_BASE_URL: base, AUTH_MODE: "disabled" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = server.output();
    const request = (path: string, body?: unknown) =>
      fetch(
        base + path,
        body === undefined ? {} : {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    const read = async (path: string) => {
      const response = await request(path);
      const text = await response.text();
      assertEquals(response.status, 200, text);
      return text;
    };
    const patch = async (path: string, body: unknown, status = 200) => {
      const response = await request(path, body);
      const result = await response.json();
      assertEquals(response.status, status, JSON.stringify(result));
      return result;
    };
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const response = await request("/health");
          await response.body?.cancel();
          if (response.ok) break;
        } catch { /* Server is starting. */ }
        if (attempt === 99) throw new Error("Testovací web se nespustil.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await sql`INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Review test', ${`https://example.test/${podcastId}`})`;
      await sql`INSERT INTO persons (id, display_name, normalized_name) VALUES
        (${personId}, 'Žofie Nováková', 'zofie novakova'),
        (${foreignPersonId}, 'Jiný podcast', 'jiny podcast')`;
      await sql`INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${podcastId}, ${personId}, 'guest')`;
      for (const [index, id] of episodes.entries()) {
        const runId = crypto.randomUUID();
        const clusterId = crypto.randomUUID();
        await sql`INSERT INTO episodes (id, podcast_id, external_id, title, audio_url,
          processing_status, published_at, transcript_selection_pending)
          VALUES (${id}, ${podcastId}, ${id}, ${`Review ${index}`}, 'https://example.test/audio',
            'ready', ${`2026-10-${index === 1 ? "27" : "26"}T00:00:00Z`}, ${index === 2})`;
        await sql`INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
          VALUES (${runId}, ${id}, 'completed', 'test')`;
        if (index !== 2) {
          await sql`UPDATE episodes SET active_processing_run_id = ${runId} WHERE id = ${id}`;
        }
        await sql`INSERT INTO speaker_clusters (id, episode_id, processing_run_id, local_label)
          VALUES (${clusterId}, ${id}, ${runId}, 'SPEAKER_00')`;
        await sql`INSERT INTO utterances (id, episode_id, processing_run_id, speaker_cluster_id,
          sequence_number, start_seconds, end_seconds, text)
          VALUES (${index === 0 ? utteranceId : crypto.randomUUID()}, ${id}, ${runId}, ${clusterId},
            0, 0, 5, 'Zachovaný přepis.')`;
      }
      const snapshot = async () =>
        (await sql`SELECT e.processing_status, e.rag_excluded,
        e.active_processing_run_id, e.transcript_selection_pending, u.text, u.person_id,
        u.speaker_assignment_source, c.identity_status
        FROM episodes e JOIN utterances u ON u.episode_id = e.id
        JOIN speaker_clusters c ON c.id = u.speaker_cluster_id WHERE e.id = ${skippedId}`)[0];
      const before = await snapshot();
      assertStringIncludes(await read(`/episodes/${currentId}`), `href="/episodes/${skippedId}"`);
      const skipPath = `/api/episodes/${skippedId}/speaker-review`;
      await patch(skipPath, { skipped: "true" }, 400);
      await patch(`/api/episodes/${crypto.randomUUID()}/speaker-review`, { skipped: true }, 404);
      for (let attempt = 0; attempt < 2; attempt++) {
        assertEquals(await patch(skipPath, { skipped: true }), {
          episodeId: skippedId,
          skipped: true,
        });
      }
      assertEquals(await snapshot(), before);
      const next = await read(`/episodes/${currentId}`);
      assertEquals(next.includes(`href="/episodes/${skippedId}"`), false);
      assertStringIncludes(next, `href="/episodes/${pendingId}"`);
      const skippedList = await read(`/podcasts/${podcastId}?status=skipped`);
      assertStringIncludes(skippedList, `href="/episodes/${skippedId}"`);
      assertEquals(skippedList.includes(`href="/episodes/${currentId}"`), false);
      assertEquals(
        (await read(`/podcasts/${podcastId}?status=ready`)).includes(
          `href="/episodes/${skippedId}"`,
        ),
        false,
      );
      assertStringIncludes(await read(`/episodes/${skippedId}`), "Vrátit k přiřazování hlasů");
      await patch(`/api/episodes/${pendingId}/speaker-review`, { skipped: true });
      assertEquals((await read(`/episodes/${currentId}`)).includes("Další díl →"), false);
      const progress = JSON.parse(await read(`/api/podcasts/${podcastId}/automation-status`));
      assertEquals([progress.processedCount, progress.remainingCount, progress.reviewCount], [
        3,
        0,
        1,
      ]);
      await patch(skipPath, { skipped: false });
      assertStringIncludes(await read(`/episodes/${currentId}`), `href="/episodes/${skippedId}"`);
      assertEquals(await snapshot(), before);

      const speakerPath = `/api/utterances/${utteranceId}/speaker`;
      await patch(speakerPath, { speaker: foreignPersonId }, 404);
      assertEquals(await patch(speakerPath, { speaker: personId }), {
        ok: true,
        utteranceId,
        personId,
        source: "manual",
        speakerLabel: "Žofie Nováková",
      });
      assertStringIncludes(
        await read(`/episodes/${currentId}`),
        "data-utterance-speaker-label>Žofie Nováková",
      );
      assertEquals(await patch(speakerPath, { speaker: "unknown" }), {
        ok: true,
        utteranceId,
        personId: null,
        source: "manual",
        speakerLabel: "Neznámý mluvčí",
      });
      assertEquals(await patch(speakerPath, { speaker: "cluster" }), {
        ok: true,
        utteranceId,
        personId: null,
        source: "cluster",
        speakerLabel: "SPEAKER_00",
      });
    } finally {
      server.kill("SIGTERM");
      await output;
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql`DELETE FROM persons WHERE id IN (${personId}, ${foreignPersonId})`;
      await sql.end({ timeout: 5 });
    }
  },
});
