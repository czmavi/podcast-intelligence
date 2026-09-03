interface BenchmarkResult {
  request: number;
  status: number;
  ttftMs: number;
  totalMs: number;
  completionTokens: number;
  finishReason: string | null;
}

interface StreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: { completion_tokens?: number } | null;
}

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

const baseUrl = argument("--url");
const model = argument("--model");
const concurrency = Number(argument("--concurrency") ?? "1");
const maxTokens = Number(argument("--max-tokens") ?? "256");
const apiKey = Deno.env.get("BENCH_API_KEY");

if (!baseUrl || !model || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
  throw new Error(
    "Použití: --url URL --model MODEL [--concurrency N] [--max-tokens N]",
  );
}
const configuredBaseUrl = baseUrl;
const configuredModel = model;

function messages(request: number): Array<{ role: "system" | "user"; content: string }> {
  const sources = Array.from({ length: 8 }, (_, sourceIndex) => ({
    sourceId: `source-${sourceIndex + 1}`,
    excerpt: Array.from(
      { length: 24 },
      (_, sentenceIndex) =>
        `Měřicí scénář ${request + 1}-${sourceIndex + 1}-${sentenceIndex + 1} popisuje ` +
        "řízení elektrické sítě, spotřebu domácností, akumulaci energie a chytré elektroměry.",
    ).join(" "),
  }));
  return [
    {
      role: "system",
      content:
        "Odpovídej česky z dodaných zdrojů. Pro tento výkonnostní test pokračuj až do limitu tokenů.",
    },
    {
      role: "user",
      content: JSON.stringify({
        question: "Shrň souvislosti mezi řízením sítě, spotřebou a akumulací.",
        sources,
      }),
    },
  ];
}

async function runRequest(request: number): Promise<BenchmarkResult> {
  const started = performance.now();
  const response = await fetch(
    new URL("chat/completions", `${configuredBaseUrl.replace(/\/+$/, "")}/`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: configuredModel,
        messages: messages(request),
        temperature: 0,
        max_tokens: maxTokens,
        ignore_eos: true,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(600_000),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Request ${request + 1} vrátil HTTP ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt: number | undefined;
  let completionTokens = 0;
  let finishReason: string | null = null;

  const consumeLine = (line: string): void => {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as StreamChunk;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (
      firstTokenAt === undefined &&
      ((delta?.content?.length ?? 0) > 0 || (delta?.reasoning?.length ?? 0) > 0 ||
        (delta?.reasoning_content?.length ?? 0) > 0)
    ) {
      firstTokenAt = performance.now();
    }
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (typeof chunk.usage?.completion_tokens === "number") {
      completionTokens = chunk.usage.completion_tokens;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(buffer);
  const finished = performance.now();
  return {
    request: request + 1,
    status: response.status,
    ttftMs: Math.round((firstTokenAt ?? finished) - started),
    totalMs: Math.round(finished - started),
    completionTokens: completionTokens || maxTokens,
    finishReason,
  };
}

const batchStarted = performance.now();
const results = await Promise.all(
  Array.from({ length: concurrency }, (_, request) => runRequest(request)),
);
const wallMs = performance.now() - batchStarted;
const totalCompletionTokens = results.reduce((sum, result) => sum + result.completionTokens, 0);
const promptCharacters = messages(0).at(1)?.content.length ?? 0;

console.log(JSON.stringify(
  {
    concurrency,
    maxTokens,
    promptCharacters,
    wallMs: Math.round(wallMs),
    aggregateTokensPerSecond: Number((totalCompletionTokens / (wallMs / 1000)).toFixed(2)),
    results,
  },
  null,
  2,
));
