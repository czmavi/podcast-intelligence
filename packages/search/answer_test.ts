import { assertEquals, assertRejects } from "@std/assert";
import {
  type AnswerGenerationStreamEvent,
  type GroundingSource,
  OpenAiCompatibleAnswerProvider,
} from "./answer.ts";

const sources: GroundingSource[] = [{
  sourceId: "source-1",
  episodeId: "200065d7-a95c-45f8-872c-bb16fd455c9f",
  episodeTitle: "Testovací epizoda",
  publishedAt: "2026-08-28T12:00:00.000Z",
  startSeconds: 10,
  endSeconds: 20,
  speakerNames: ["Host"],
  excerpt: "Dodaný zdrojový text.",
}];

function providerWithResponse(content: string) {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAiCompatibleAnswerProvider({
    baseUrl: "http://llm.test:8002/v1",
    model: "bottlecapai/ThinkingCap-Qwen3.6-27B",
    apiKey: "test-token",
    timeoutMs: 1000,
    maxTokens: 500,
    reasoningEffort: "none",
    thinkingTokenBudget: 160,
  }, (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return { provider, requestBody: () => requestBody };
}

Deno.test("answer provider validuje uzemněnou JSON odpověď", async () => {
  const setup = providerWithResponse(
    '<think>interní úvaha</think>\n```json\n{"answer":"Odpověď.","sections":[' +
      '{"title":"Téma","text":"Podrobnost.","sourceIds":["source-1"]}],' +
      '"confidence":"high","sourceIds":["source-1"]}\n```',
  );
  assertEquals(
    await setup.provider.generateGroundedAnswer({ question: "Co zaznělo?", sources }),
    {
      answer: "Odpověď.",
      sections: [{ title: "Téma", text: "Podrobnost.", sourceIds: ["source-1"] }],
      confidence: "high",
      sourceIds: ["source-1"],
    },
  );
  assertEquals(setup.requestBody()?.model, "bottlecapai/ThinkingCap-Qwen3.6-27B");
  assertEquals(setup.requestBody()?.reasoning_effort, "none");
  assertEquals(setup.requestBody()?.chat_template_kwargs, { enable_thinking: false });
  assertEquals(setup.requestBody()?.thinking_token_budget, undefined);
  const messages = setup.requestBody()?.messages as Array<{ content: string }>;
  const prompt = JSON.parse(messages[1]!.content);
  assertEquals(prompt.sources[0].publishedDate, "28. 8. 2026");
  assertEquals(prompt.sources[0].timestamp, "00:00:10");
});

Deno.test("answer provider pošle vLLM omezený reasoning režim", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  let requestNumber = 0;
  const provider = new OpenAiCompatibleAnswerProvider({
    baseUrl: "http://llm.test:8002/v1",
    model: "test-model",
    timeoutMs: 1000,
    maxTokens: 4096,
    reasoningEffort: "high",
    thinkingTokenBudget: 2048,
  }, (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    requestNumber += 1;
    return Promise.resolve(
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: requestNumber === 1
              ? "Promyšlený návrh odpovědi se zdrojem source-1."
              : '{"answer":"Odpověď.","sections":[{"title":"Téma","text":' +
                '"Podrobnost.","sourceIds":["source-1"]}],"confidence":"high",' +
                '"sourceIds":["source-1"]}',
          },
        }],
      })),
    );
  });

  await provider.generateGroundedAnswer({ question: "Co zaznělo?", sources });
  assertEquals(requestBodies.length, 2);
  assertEquals(requestBodies[0]?.reasoning_effort, "high");
  assertEquals(requestBodies[0]?.chat_template_kwargs, { enable_thinking: true });
  assertEquals(requestBodies[0]?.thinking_token_budget, 2048);
  assertEquals(requestBodies[0]?.response_format, undefined);
  assertEquals(requestBodies[1]?.reasoning_effort, "none");
  assertEquals(requestBodies[1]?.chat_template_kwargs, { enable_thinking: false });
  assertEquals(requestBodies[1]?.thinking_token_budget, undefined);
  assertEquals(requestBodies[1]?.include_reasoning, false);
});

Deno.test("GPT-5.6 Luna používá standardní OpenAI Chat Completions parametry", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  let requestNumber = 0;
  const provider = new OpenAiCompatibleAnswerProvider({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    apiKey: "test-openai-key",
    timeoutMs: 1000,
    maxTokens: 4000,
    reasoningEffort: "low",
    thinkingTokenBudget: 0,
    protocol: "openai",
  }, (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    requestNumber += 1;
    return Promise.resolve(Response.json({
      choices: [{
        message: {
          content: requestNumber === 1
            ? "Pracovní analýza source-1."
            : '{"answer":"Odpověď.","sections":[{"title":"Téma","text":' +
              '"Podrobnost.","sourceIds":["source-1"]}],"confidence":"high",' +
              '"sourceIds":["source-1"]}',
        },
      }],
    }));
  });

  await provider.generateGroundedAnswer({ question: "Co zaznělo?", sources });
  assertEquals(requestBodies.length, 2);
  assertEquals(requestBodies[0]?.model, "gpt-5.6-luna");
  assertEquals(requestBodies[0]?.max_completion_tokens, 4000);
  assertEquals(requestBodies[0]?.reasoning_effort, "low");
  assertEquals(requestBodies[0]?.max_tokens, undefined);
  assertEquals(requestBodies[0]?.chat_template_kwargs, undefined);
  assertEquals(requestBodies[0]?.thinking_token_budget, undefined);
  assertEquals(requestBodies[1]?.reasoning_effort, "none");
  assertEquals(requestBodies[1]?.max_completion_tokens, 1000);
  assertEquals(requestBodies[1]?.response_format, { type: "json_object" });
});

Deno.test("answer provider odmítne odkaz na neznámý zdroj", async () => {
  const { provider } = providerWithResponse(
    '{"answer":"Odpověď.","sections":[{"title":"Téma","text":"Podrobnost.",' +
      '"sourceIds":["source-1"]}],"confidence":"high","sourceIds":["source-99"]}',
  );
  await assertRejects(
    () => provider.generateGroundedAnswer({ question: "Co zaznělo?", sources }),
    Error,
    "neznámý zdroj",
  );
});

Deno.test("answer provider odmítne neznámý zdroj v tematické sekci", async () => {
  const { provider } = providerWithResponse(
    '{"answer":"Odpověď.","sections":[{"title":"Téma","text":"Podrobnost.",' +
      '"sourceIds":["source-99"]}],"confidence":"high","sourceIds":["source-1"]}',
  );
  await assertRejects(
    () => provider.generateGroundedAnswer({ question: "Co zaznělo?", sources }),
    Error,
    "tematické sekci",
  );
});

Deno.test("answer provider streamuje dekódovaný text a fáze z JSON odpovědi", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const pieces = [
    '{"answer":"První ',
    'řádek\\nDruhý s \\"uvozovkou\\".',
    '","sections":[{"title":"Téma","text":"Podrobnost.",' +
    '"sourceIds":["source-1"]}],"confidence":"high","sourceIds":["source-1"]}',
  ];
  const sse =
    pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      .join("") + `data: ${
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
      })
    }\n\ndata: [DONE]\n\n`;
  const provider = new OpenAiCompatibleAnswerProvider({
    baseUrl: "http://llm.test:8002/v1",
    model: "test-model",
    timeoutMs: 1000,
    maxTokens: 500,
    reasoningEffort: "none",
    thinkingTokenBudget: 0,
  }, (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  });

  const events: AnswerGenerationStreamEvent[] = [];
  for await (const event of provider.streamGroundedAnswer({ question: "Co zaznělo?", sources })) {
    events.push(event);
  }

  assertEquals(requestBody?.stream, true);
  assertEquals(requestBody?.stream_options, { include_usage: true });
  assertEquals(
    events.filter((event) => event.type === "phase").map((event) => event.phase),
    ["answer", "citations"],
  );
  assertEquals(
    events.filter((event) => event.type === "delta").map((event) => event.text).join(""),
    'První řádek\nDruhý s "uvozovkou".',
  );
  assertEquals(events.at(-1), {
    type: "complete",
    answer: {
      answer: 'První řádek\nDruhý s "uvozovkou".',
      sections: [{ title: "Téma", text: "Podrobnost.", sourceIds: ["source-1"] }],
      confidence: "high",
      sourceIds: ["source-1"],
    },
    usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
  });
});

Deno.test("answer provider sečte tokeny analýzy a finální odpovědi", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  let requestNumber = 0;
  const finalAnswer = '{"answer":"Odpověď.","sections":[{"title":"Téma",' +
    '"text":"Podrobnost.","sourceIds":["source-1"]}],"confidence":"high",' +
    '"sourceIds":["source-1"]}';
  const provider = new OpenAiCompatibleAnswerProvider({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    apiKey: "test-openai-key",
    timeoutMs: 1000,
    maxTokens: 4000,
    reasoningEffort: "low",
    thinkingTokenBudget: 0,
    protocol: "openai",
  }, (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    requestNumber += 1;
    if (requestNumber === 1) {
      return Promise.resolve(Response.json({
        choices: [{ message: { content: "Pracovní analýza source-1." } }],
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
      }));
    }
    const sse = `data: ${
      JSON.stringify({
        choices: [{ delta: { content: finalAnswer } }],
        usage: null,
      })
    }\n\ndata: ${
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 140, completion_tokens: 35, total_tokens: 175 },
      })
    }\n\ndata: [DONE]\n\n`;
    return Promise.resolve(new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  });

  const events: AnswerGenerationStreamEvent[] = [];
  for await (const event of provider.streamGroundedAnswer({ question: "Co zaznělo?", sources })) {
    events.push(event);
  }

  assertEquals(requestBodies[1]?.stream_options, { include_usage: true });
  assertEquals(events.at(-1), {
    type: "complete",
    answer: {
      answer: "Odpověď.",
      sections: [{ title: "Téma", text: "Podrobnost.", sourceIds: ["source-1"] }],
      confidence: "high",
      sourceIds: ["source-1"],
    },
    usage: { promptTokens: 240, completionTokens: 60, totalTokens: 300 },
  });
});
