import { assert, assertEquals } from "@std/assert";
import { createDatabase } from "../database/client.ts";
import { loadConfig } from "../shared/config.ts";
import { findAnswerSources } from "./answer-sources.ts";

Deno.test({
  name:
    "integration: rozšíření najde pozdější samostatnou zmínku a nepřisoudí výrok hosta moderátorovi",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "1",
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const otherPodcast = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const question = "Jak se vyvíjel jeho názor na to, kdo bude lepší americký prezident";
    const input = { question: question + "?", podcastId, personId };
    try {
      await sql.begin(async (tx) => {
        for (const id of [podcastId, otherPodcast]) {
          await tx`INSERT INTO podcasts (id, name, rss_url) VALUES (${id}, 'Test', ${id})`;
        }
        await tx`INSERT INTO persons (id, display_name, normalized_name)
          VALUES (${personId}, 'Testovací moderátor', 'testovaci moderator')`;
        for (let i = 1; i <= 17; i++) {
          const episode = crypto.randomUUID(),
            run = crypto.randomUUID(),
            cluster = crypto.randomUUID();
          const host = i === 1
            ? "Americký prezident, Harrisová i Trump kandidují."
            : i <= 10
            ? "Trump ve volbách. Trump ve volbách. Trump ve volbách."
            : i === 12
            ? "Dnes se pobavíme o filmu."
            : "Kandidátka Harrisová.";
          const guest = "Podle hosta by měla vyhrát Harrisová.";
          await tx`INSERT INTO episodes (id,podcast_id,external_id,title,published_at,audio_url,rag_excluded)
            VALUES (${episode},${i === 13 ? otherPodcast : podcastId},${String(i)},${"Díl " + i},
              ${
            i === 17 ? null : "2024-10-" + String(i).padStart(2, "0")
          },'https://example.test/a',${i === 14})`;
          await tx`INSERT INTO processing_runs (id,episode_id,status,pipeline_version)
            VALUES (${run},${episode},'completed','test')`;
          if (i !== 15) {
            await tx`UPDATE episodes SET active_processing_run_id = ${run} WHERE id = ${episode}`;
          }
          await tx`INSERT INTO speaker_clusters (id,episode_id,processing_run_id,local_label)
            VALUES (${cluster},${episode},${run},'test')`;
          const [chunk] =
            await tx`INSERT INTO content_chunks (episode_id,processing_run_id,start_seconds,end_seconds,text,token_count)
            VALUES (${episode},${run},0,20,${host + " " + guest},20) RETURNING id`;
          for (const [seq, text] of [host, guest].entries()) {
            const [utterance] =
              await tx`INSERT INTO utterances (episode_id,processing_run_id,speaker_cluster_id,
              person_id,sequence_number,start_seconds,end_seconds,text) VALUES
              (${episode},${run},${cluster},${seq === 0 ? personId : null},${seq},${seq * 10},${
                (seq + 1) * 10
              },${text}) RETURNING id`;
            await tx`INSERT INTO content_chunk_utterances (content_chunk_id,utterance_id,position)
              VALUES (${chunk!.id},${utterance!.id},${seq})`;
          }
        }
      });
      const plans = {
        expandSearch: () =>
          Promise.resolve({
            passageQuery: "Koho preferuje?",
            names: ["Trump", "Harris"],
            alternatives: [],
            timeline: true,
          }),
      };
      const baseline = await findAnswerSources(sql, input, null);
      assertEquals(baseline.sources.map((s) => s.episodeTitle), ["Díl 1"]);
      const reranker = {
        minRerankScore: 0.2,
        candidateLimit: 48,
        rerank(query: string, excerpts: string[]) {
          assert(query === input.question || query === "Koho preferuje?");
          return Promise.resolve(
            excerpts.map((text) => text.startsWith("Kandidátka") ? 0.15 : 0.88),
          );
        },
      };
      for (const q of [input.question, question + ", Kamala Harris nebo Donald Trump?"]) {
        const { sources, warnings } = await findAnswerSources(
          sql,
          { ...input, question: q },
          plans,
          reranker,
        );
        assertEquals(warnings, []);
        assertEquals(sources.length, 8);
        assertEquals(sources[0]?.episodeTitle, "Díl 1");
        assert(sources.some((s) => s.episodeTitle === "Díl 16"));
        assert(
          sources.every((s) =>
            !s.excerpt.includes("hosta") && s.speakerNames[0] === "Testovací moderátor"
          ),
        );
        assert(
          sources.every((s) => !["Díl 12", "Díl 13", "Díl 14", "Díl 15"].includes(s.episodeTitle)),
        );
      }
      const window = { ...input, dateFrom: "2024-10-11", dateTo: "2024-10-16" };
      let rounds = 0;
      const refined = await findAnswerSources(sql, input, {
        expandSearch: ({ hints, previousNames }) => {
          rounds++;
          assertEquals(previousNames, rounds === 1 ? undefined : ["Trump"]);
          if (rounds === 2) assert(hints.some((h) => h.excerpt.includes("Trump")));
          return Promise.resolve({
            passageQuery: "Koho preferuje?",
            names: rounds === 1 ? ["Trump"] : ["Harris", "Trump"],
            alternatives: [],
            timeline: true,
            usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
          });
        },
      }, reranker);
      assertEquals(rounds, 2);
      assertEquals(refined.usage?.totalTokens, 6);
      assert(refined.sources.some((s) => s.episodeTitle === "Díl 16"));
      assertEquals(new Set(refined.sources.map((s) => s.episodeId)).size, refined.sources.length);
      const late = await findAnswerSources(sql, window, plans);
      assertEquals(late.sources.map((s) => s.episodeTitle), ["Díl 11", "Díl 16"]);
      assertEquals(
        (await findAnswerSources(sql, { ...window, episodeId: late.sources[0]!.episodeId }, plans))
          .sources.length,
        1,
      );
      assert(
        (await findAnswerSources(sql, { ...window, personId: undefined }, plans)).sources.some(
          (s) => s.episodeTitle === "Díl 12",
        ),
      );
      const failed = await findAnswerSources(sql, input, {
        expandSearch: () => Promise.reject(new Error("timeout")),
      });
      assertEquals(failed.sources, baseline.sources);
      assertEquals(failed.warnings.length, 1);
      const unavailable = await findAnswerSources(sql, window, plans, {
        ...reranker,
        rerank: () => Promise.reject(new Error("unavailable")),
      });
      assertEquals(unavailable.sources, late.sources);
      assertEquals(unavailable.warnings.length, 1);
      const weak = await findAnswerSources(sql, input, plans, {
        ...reranker,
        rerank: (_question, excerpts) => Promise.resolve(excerpts.map(() => 0.001)),
      });
      assertEquals(weak.sources, baseline.sources);
      assertEquals(weak.warnings.length, 1);
    } finally {
      try {
        await sql.begin(async (tx) => {
          await tx`DELETE FROM podcasts WHERE id IN (${podcastId},${otherPodcast})`;
          await tx`DELETE FROM persons WHERE id = ${personId}`;
        });
      } finally {
        await sql.end();
      }
    }
  },
});
