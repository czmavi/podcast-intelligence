import { assertEquals, assertFalse } from "@std/assert";
import { z } from "zod";
import { loadConfig } from "../shared/config.ts";
import {
  answerProviderIds,
  createAnswerProviders,
  openAiAnswerModels,
} from "./answer-providers.ts";
import type { GroundingSource } from "./answer.ts";

const sources: GroundingSource[] = [{
  sourceId: "source-1",
  episodeId: "episode",
  episodeTitle: "Test",
  publishedAt: null,
  startSeconds: 0,
  endSeconds: 10,
  speakerNames: ["Mluvčí"],
  excerpt: "Testovací zdrojový výrok.",
}];
const answer = {
  answer: "Shrnutí.",
  sections: [{ title: "Téma", text: "Doložený výrok.", sourceIds: ["source-1"] }],
  sourceIds: ["source-1"],
  confidence: "high",
};

for (const effort of ["none", "low"] as const) {
  Deno.test(`OpenAI volby routují správný model i reasoning (${effort}) v JSON a streamu`, async () => {
    const requests: Record<string, unknown>[] = [];
    const providers = createAnswerProviders(
      loadConfig({ OPENAI_API_KEY: "test-api-key", OPENAI_ANSWER_REASONING_EFFORT: effort }),
      (url, init) => {
        assertEquals(String(url), "https://api.openai.com/v1/chat/completions");
        assertEquals(new Headers(init?.headers).get("authorization"), "Bearer test-api-key");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const content = JSON.stringify(answer);
        return Promise.resolve(
          body.stream
            ? new Response(
              `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
            : Response.json({ choices: [{ message: { content } }] }),
        );
      },
    );
    for (const model of openAiAnswerModels) {
      const provider = providers.get(model.id);
      if (!provider) throw new Error("Chybí provider");
      for (const streaming of [false, true]) {
        requests.length = 0;
        if (streaming) {
          const events = [];
          for await (
            const event of provider.streamGroundedAnswer({ question: "Co zaznělo?", sources })
          ) events.push(event);
          assertEquals(events.at(-1)?.type, "complete");
        } else {
          assertEquals(
            await provider.generateGroundedAnswer({ question: "Co zaznělo?", sources }),
            answer,
          );
        }
        const floor = model.id === "gpt-6.1-sol" ? "low" : "none";
        assertEquals(requests.length, effort === "low" || floor === "low" ? 2 : 1);
        assertEquals(requests.at(-1)?.reasoning_effort, floor);
        assertEquals(requests.at(-1)?.response_format, { type: "json_object" });
        assertEquals(requests.at(-1)?.stream, streaming ? true : undefined);
        for (const request of requests) {
          assertEquals(request.model, model.id);
          assertEquals(request.max_completion_tokens, 4000);
          assertEquals(request.max_tokens, undefined);
          assertEquals(request.temperature, undefined);
          assertEquals(request.chat_template_kwargs, undefined);
        }
      }
    }
  });
}

Deno.test("OpenAI volby bez klíče zůstanou nedostupné a zachovají původní konfiguraci", async () => {
  const disabled = createAnswerProviders(loadConfig({}));
  assertEquals([...disabled.values()], answerProviderIds.map(() => null));
  assertFalse(z.enum(answerProviderIds).safeParse("unknown-model").success);
  const requests: Record<string, unknown>[] = [];
  const configured = createAnswerProviders(
    loadConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_ANSWER_MODEL: "gpt-6.1-sol",
      OPENAI_ANSWER_REASONING_EFFORT: "none",
    }),
    (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
      );
    },
  );
  await configured.get("gpt-5.6-luna")!.generateGroundedAnswer({ question: "Dotaz", sources });
  assertEquals(requests.map((r) => r.model), ["gpt-6.1-sol", "gpt-6.1-sol"]);
  assertEquals(requests.map((r) => r.reasoning_effort), ["low", "low"]);
});
