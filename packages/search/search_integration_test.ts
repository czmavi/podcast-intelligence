import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
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

Deno.test({
  name: "integration: analýza pokryje různé epizody přes duplicity a přesně filtruje N i mluvčího",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
    const sentence = "Marek Benda zakázal lidem z ODS komunikovat s Deníkem N. ";
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO podcasts (id, name, rss_url)
          VALUES (${podcastId}, 'Diverse sources', ${`https://example.test/${podcastId}`})`;
        await tx`INSERT INTO persons (id, display_name, normalized_name)
          VALUES (${personId}, 'Michal Půr', ${personId})`;
        for (const [index, episodeId] of ids.entries()) {
          const runId = crypto.randomUUID();
          const clusterId = crypto.randomUUID();
          await tx`INSERT INTO episodes (id, podcast_id, external_id, title, audio_url, published_at)
            VALUES (${episodeId}, ${podcastId}, ${String(index)}, ${`Díl ${index}`},
              'https://example.test/audio', '2026-01-01')`;
          await tx`INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
            VALUES (${runId}, ${episodeId}, 'completed', 'test')`;
          await tx`UPDATE episodes SET active_processing_run_id=${runId} WHERE id=${episodeId}`;
          await tx`INSERT INTO speaker_clusters (id, episode_id, processing_run_id, local_label)
            VALUES (${clusterId}, ${episodeId}, ${runId}, 'SPEAKER_00')`;
          const texts = index === 0
            ? [
              ...Array.from({ length: 70 }, (_, n) => sentence.repeat(12) + `Smyčka ${n}.`),
              sentence,
              sentence,
              sentence.toUpperCase(),
            ]
            : [
              index === 1
                ? "Deník N podle něj nedostatečně popisuje své sponzory."
                : index === 2
                ? "V Deníku N vyšel rozhovor s prezidentem."
                : index === 3
                ? "Deník Sport napsal novou reportáž."
                : index === 4
                ? "Deník N zveřejnil výroční zprávu."
                : "Deník N uvedl jiné informace o médiích.",
            ];
          for (const [sequence, text] of texts.entries()) {
            const chunkId = crypto.randomUUID();
            const utteranceId = crypto.randomUUID();
            await tx`INSERT INTO utterances (
              id, episode_id, processing_run_id, speaker_cluster_id, person_id,
              sequence_number, start_seconds, end_seconds, text
            ) VALUES (${utteranceId}, ${episodeId}, ${runId}, ${clusterId},
              ${index === 4 ? null : personId}, ${sequence}, ${sequence * 30},
              ${sequence * 30 + 20}, ${text})`;
            await tx`INSERT INTO content_chunks (
              id, episode_id, processing_run_id, start_seconds, end_seconds, text, token_count
            ) VALUES (${chunkId}, ${episodeId}, ${runId}, ${sequence * 30},
              ${sequence * 30 + 20}, ${text}, 20)`;
            await tx`INSERT INTO content_chunk_utterances (content_chunk_id, utterance_id, position)
              VALUES (${chunkId}, ${utteranceId}, 0)`;
            if (index === 4) {
              // Celý chunk téma obsahuje, vybraný mluvčí však hovořil o něčem jiném.
              const otherId = crypto.randomUUID();
              await tx`INSERT INTO utterances (
                id, episode_id, processing_run_id, speaker_cluster_id, person_id,
                sequence_number, start_seconds, end_seconds, text
              ) VALUES (${otherId}, ${episodeId}, ${runId}, ${clusterId}, ${personId},
                1, 21, 25, 'Mluvím o Deníku Sport, nikoli o jiném médiu.')`;
              await tx`INSERT INTO content_chunk_utterances (content_chunk_id, utterance_id, position)
                VALUES (${chunkId}, ${otherId}, 1)`;
            }
          }
          if (index === 5) {
            // Index staré varianty nesmí prosáknout do výsledků.
            await tx`UPDATE episodes SET active_processing_run_id=NULL WHERE id=${episodeId}`;
          }
        }
      });
      const input = {
        query: "deníku N",
        podcastId,
        personId,
        limit: 16,
        mode: "fulltext" as const,
        precision: "balanced" as const,
      };
      const options = { lexicalMatch: "all" as const, diversifyEpisodes: true };
      const results = await search(sql, input, provider, options);
      assertEquals(new Set(results.map((r) => r.episodeId)), new Set(ids.slice(0, 3)));
      assertEquals(results.length, 3);
      assertEquals(results.find((r) => r.episodeId === ids[0])?.text, sentence);
      const single = await search(sql, { ...input, episodeId: ids[1]! }, provider, options);
      assertEquals(single.map((r) => r.episodeId), [ids[1]]);
      assertEquals(await search(sql, { ...input, dateFrom: "2026-02-01" }, provider, options), []);
      const socket = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const base = `http://127.0.0.1:${socket.addr.port}`;
      socket.close();
      const model = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        async (request) => {
          const body = await request.json();
          const data = JSON.parse(body.messages[1].content);
          return Response.json({
            choices: [{
              message: {
                content: JSON.stringify({
                  sections: data.sources.map((source: { sourceId: string; excerpt: string }) => ({
                    title: "Vyjádření k médiím",
                    quotes: [{ sourceId: source.sourceId, quote: source.excerpt }],
                  })),
                }),
              },
            }],
          });
        },
      );
      const server = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", fromFileUrl(new URL("../../apps/web/main.ts", import.meta.url))],
        env: {
          APP_ENV: "test",
          APP_BASE_URL: base,
          AUTH_MODE: "disabled",
          ANSWER_GENERATION_PROVIDER: "openai-compatible",
          ANSWER_GENERATION_BASE_URL: `http://127.0.0.1:${model.addr.port}/v1`,
          ANSWER_GENERATION_MODEL: "test-quotes",
          ANSWER_GENERATION_REASONING_EFFORT: "none",
          OPENAI_API_KEY: "",
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = server.output();
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const response = await fetch(`${base}/health`);
            await response.body?.cancel();
            if (response.ok) break;
          } catch { /* Testovací server startuje. */ }
          if (attempt === 99) throw new Error("Testovací web se nespustil.");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        for (
          const question of [
            "Co říká o deníku N",
            "Jak hodnotí deník n",
            "Jaký má názor na Deník N?",
            "Jak Michal Půr hodnotí Deník N a jak se jeho názor v čase měnil?",
          ]
        ) {
          for (const streaming of [false, true]) {
            const response = await fetch(`${base}/api/ask`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: streaming ? "application/x-ndjson" : "application/json",
              },
              body: JSON.stringify({ question, podcastId, personId }),
            });
            assertEquals(response.status, 200);
            const text = await response.text();
            const events = streaming ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
            const result = streaming ? events.at(-1) : JSON.parse(text);
            assertEquals(
              new Set(result.sources.map((s: { episodeId: string }) => s.episodeId)),
              new Set(ids.slice(0, 3)),
            );
            assertEquals(result.sources.length, 3);
            assertEquals(
              result.answer,
              "Vybrané doslovné citace z přepisů, uspořádané podle témat.",
            );
            assertEquals(result.sections.length, 3);
            for (const section of result.sections) {
              assertEquals(section.quotes.length, 1);
              const quote = section.quotes[0];
              const source = result.sources.find((s: { sourceId: string }) =>
                s.sourceId === quote.sourceId
              );
              assertEquals(quote.text, source.excerpt.trim());
            }
            if (streaming) {
              assertEquals(
                events.find((e) => e.phase === "sources")?.message,
                "Vybráno úryvků pro odpověď: 3 z 3 epizod",
              );
            }
          }
        }
        const searchPage = await (await fetch(`${base}/search`)).text();
        for (const answerProvider of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
          assertStringIncludes(searchPage, `value="${answerProvider}" disabled`);
          const response = await fetch(`${base}/api/ask`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              question: "Jak hodnotí deník n",
              podcastId,
              personId,
              answerProvider,
            }),
          });
          assertEquals(response.status, 200);
          const result = await response.json();
          assertEquals(result.answer, null);
          assertEquals(result.sources.length, 3);
          assertStringIncludes(result.warnings[0], answerProvider);
        }
      } finally {
        server.kill("SIGTERM");
        await output;
        await model.shutdown();
      }
      await sql`UPDATE episodes SET rag_excluded=true WHERE id=${ids[2]!}`;
      const remaining = await search(sql, input, provider, options);
      assertEquals(new Set(remaining.map((r) => r.episodeId)), new Set(ids.slice(0, 2)));
    } finally {
      await sql`DELETE FROM podcasts WHERE id=${podcastId}`;
      await sql`DELETE FROM persons WHERE id=${personId}`;
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: "integration: srovnání najde oddělená příjmení jen u vybraného mluvčího",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const ids = Array.from({ length: 7 }, () => crypto.randomUUID());
    const texts = [
      "Trumpa považuji za kandidáta se silným ekonomickým programem.",
      "Harrisovou voliči podle mě zatím příliš dobře neznají.",
      "Trump slíbil změnit pravidla zahraničního obchodu.",
      "Trumpovi pomáhá silná podpora republikánských voličů.",
      "Harrisová má velmi zajímavou kampaň.",
      "Trump chce změnit daňové zákony.",
      "Harrisová slibuje dostupnější bydlení.",
    ];
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO podcasts (id,name,rss_url) VALUES (${podcastId}, 'Comparison', ${`https://example.test/${podcastId}`})`;
        await tx`INSERT INTO persons (id,display_name,normalized_name) VALUES (${personId}, 'Michal Půr', ${personId})`;
        for (const [index, episodeId] of ids.entries()) {
          const runId = crypto.randomUUID();
          const clusterId = crypto.randomUUID();
          const chunkId = crypto.randomUUID();
          await tx`INSERT INTO episodes (id,podcast_id,external_id,title,audio_url,published_at,rag_excluded)
            VALUES (${episodeId},${podcastId},${
            String(index)
          },${`Comparison ${index}`},'https://example.test/audio','2026-01-01',${index === 5})`;
          await tx`INSERT INTO processing_runs (id,episode_id,status,pipeline_version) VALUES (${runId},${episodeId},'completed','test')`;
          await tx`UPDATE episodes SET active_processing_run_id=${
            index === 6 ? null : runId
          } WHERE id=${episodeId}`;
          await tx`INSERT INTO speaker_clusters (id,episode_id,processing_run_id,local_label) VALUES (${clusterId},${episodeId},${runId},'SPEAKER_00')`;
          await tx`INSERT INTO content_chunks (id,episode_id,processing_run_id,start_seconds,end_seconds,text,token_count)
            VALUES (${chunkId},${episodeId},${runId},0,30,${
            texts[index]! + (index === 0 ? " Donald Trump." : index === 1 ? " Kamala Harris." : "")
          },20)`;
          const utterances = index === 4
            ? [texts[index]!, "Dnes se budeme věnovat domácí politice."]
            : [texts[index]!];
          for (const [sequence, text] of utterances.entries()) {
            const utteranceId = crypto.randomUUID();
            await tx`INSERT INTO utterances (id,episode_id,processing_run_id,speaker_cluster_id,person_id,sequence_number,start_seconds,end_seconds,text)
              VALUES (${utteranceId},${episodeId},${runId},${clusterId},${
              index === 4 && sequence === 0 ? null : personId
            },${sequence},${sequence * 10},${sequence * 10 + 10},${text})`;
            await tx`INSERT INTO content_chunk_utterances (content_chunk_id,utterance_id,position) VALUES (${chunkId},${utteranceId},${sequence})`;
          }
        }
      });
      const input = {
        query: "Donald Trump vs Kamala Harris",
        podcastId,
        personId,
        limit: 16,
        mode: "fulltext" as const,
        precision: "balanced" as const,
      };
      const options = { lexicalMatch: "all" as const, diversifyEpisodes: true };
      const results = await search(sql, input, provider, options);
      assertEquals(new Set(results.map((r) => r.episodeId)), new Set(ids.slice(0, 4)));
      const balanced = await search(sql, { ...input, limit: 2 }, provider, options);
      assertEquals(balanced.length, 2);
      assertEquals(balanced.some((r) => r.episodeId === ids[1]), true);
      assertEquals(
        (await search(sql, { ...input, episodeId: ids[1]! }, provider, options)).map((r) => r.text),
        [texts[1]],
      );
      for (
        const filters of [{ personId: crypto.randomUUID() }, { podcastId: crypto.randomUUID() }, {
          dateFrom: "2026-02-01",
        }]
      ) {
        assertEquals(await search(sql, { ...input, ...filters }, provider, options), []);
      }
    } finally {
      await sql`DELETE FROM podcasts WHERE id=${podcastId}`;
      await sql`DELETE FROM persons WHERE id=${personId}`;
      await sql.end();
    }
  },
});

Deno.test({
  name: "integration: obecná jména, pořadí plných shod a kontext nejednoznačného příjmení",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const fixtures = [
      ["Petr Fiala představil nový vládní program.", ""],
      ["Fialovi se podle mě nepodařilo přesvědčit voliče.", ""],
      ["Andrej Babiš přislíbil zvýšit důchody.", ""],
      ["Babiše kritizuji za způsob vedení kampaně.", ""],
      ["Novák podle mě dobře popsal problémy zdravotnictví.", "Hostem je Petr Novák."],
      ["Novák má podle mě jiné názory na ekonomiku.", "Dnes přišel Jan Novák."],
      ["Novák navrhuje nová opatření ve školství.", ""],
      ["Novák tentokrát příliš nepřesvědčil.", "Petr Novák diskutoval s Janem Novákem."],
      ["Česká televize vysílá novou zpravodajskou relaci.", ""],
      ["Televize je podle mě stále důležitým zdrojem zpráv.", ""],
      ["Dnes mluvíme o financování sportu.", "Petr Fiala a Andrej Babiš se střetli v debatě."],
      ["Petr Novák podporuje změnu financování škol.", "Petr Novák a Jan Novák spolu nesouhlasí."],
    ];
    const ids = fixtures.map(() => crypto.randomUUID());
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO podcasts (id,name,rss_url) VALUES (${podcastId},'General names',${`https://example.test/${podcastId}`})`;
        await tx`INSERT INTO persons (id,display_name,normalized_name) VALUES (${personId},'Michal Půr',${personId})`;
        for (const [index, texts] of fixtures.entries()) {
          const episodeId = ids[index]!;
          const runId = crypto.randomUUID();
          const clusterId = crypto.randomUUID();
          const chunkId = crypto.randomUUID();
          await tx`INSERT INTO episodes (id,podcast_id,external_id,title,audio_url,published_at)
            VALUES (${episodeId},${podcastId},${
            String(index)
          },${`General ${index}`},'https://example.test/audio','2026-01-01')`;
          await tx`INSERT INTO processing_runs (id,episode_id,status,pipeline_version) VALUES (${runId},${episodeId},'completed','test')`;
          await tx`UPDATE episodes SET active_processing_run_id=${runId} WHERE id=${episodeId}`;
          await tx`INSERT INTO speaker_clusters (id,episode_id,processing_run_id,local_label) VALUES (${clusterId},${episodeId},${runId},'SPEAKER_00')`;
          await tx`INSERT INTO content_chunks (id,episode_id,processing_run_id,start_seconds,end_seconds,text,token_count)
            VALUES (${chunkId},${episodeId},${runId},0,30,${texts.join(" ")},20)`;
          for (const [sequence, text] of texts.filter(Boolean).entries()) {
            const id = crypto.randomUUID();
            await tx`INSERT INTO utterances (id,episode_id,processing_run_id,speaker_cluster_id,person_id,sequence_number,start_seconds,end_seconds,text)
              VALUES (${id},${episodeId},${runId},${clusterId},${
              sequence === 0 ? personId : null
            },${sequence},${sequence * 10},${sequence * 10 + 10},${text})`;
            await tx`INSERT INTO content_chunk_utterances (content_chunk_id,utterance_id,position) VALUES (${chunkId},${id},${sequence})`;
          }
        }
      });
      const input = {
        query: "Petr Fiala vs Andrej Babiš",
        podcastId,
        personId,
        limit: 16,
        mode: "fulltext" as const,
        precision: "balanced" as const,
      };
      const options = { lexicalMatch: "all" as const, diversifyEpisodes: true };
      const compared = await search(sql, input, provider, options);
      assertEquals(new Set(compared.map((r) => r.episodeId)), new Set(ids.slice(0, 4)));
      assertEquals(compared.slice(0, 2).map((r) => r.episodeId), [ids[0], ids[2]]);
      const alone = await search(sql, { ...input, query: "Petr Fiala" }, provider, options);
      assertEquals(alone.map((r) => r.episodeId), [ids[0], ids[1]]);
      const ambiguous = await search(sql, { ...input, query: "Petr Novák" }, provider, options);
      assertEquals(new Set(ambiguous.map((r) => r.episodeId)), new Set([ids[4], ids[11]]));
      assertEquals(ambiguous[0]?.episodeId, ids[11]);
      assertEquals(await search(sql, { ...input, query: "David Fiala" }, provider, options), []);
      assertEquals(
        (await search(sql, { ...input, query: "Česká televize" }, provider, options)).map((r) =>
          r.episodeId
        ),
        [ids[8]],
      );
      assertEquals(await search(sql, { ...input, dateFrom: "2026-02-01" }, provider, options), []);
      // Ani kontext identity nesmí pocházet z vyloučeného či neaktivního přepisu.
      await sql`UPDATE episodes SET rag_excluded=true WHERE id=${ids[0]!}`;
      await sql`UPDATE episodes SET active_processing_run_id=NULL WHERE id=${ids[10]!}`;
      assertEquals(await search(sql, { ...input, query: "Petr Fiala" }, provider, options), []);
    } finally {
      await sql`DELETE FROM podcasts WHERE id=${podcastId}`;
      await sql`DELETE FROM persons WHERE id=${personId}`;
      await sql.end();
    }
  },
});
