import { answerGenerationApiKey, type Config } from "../shared/config.ts";
import { type AnswerGenerationProvider, OpenAiCompatibleAnswerProvider } from "./answer.ts";

export const openAiAnswerModels = [
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
] as const;

export const answerProviderIds = [
  "thinking-cap",
  ...openAiAnswerModels.map((model) => model.id),
] as const;
export type AnswerProviderId = typeof answerProviderIds[number];

export function createAnswerProviders(config: Config, fetcher: typeof fetch = fetch) {
  const providers = new Map<AnswerProviderId, AnswerGenerationProvider | null>();
  const localApiKey = answerGenerationApiKey(config);
  providers.set(
    "thinking-cap",
    config.ANSWER_GENERATION_PROVIDER === "openai-compatible" &&
      config.ANSWER_GENERATION_BASE_URL
      ? new OpenAiCompatibleAnswerProvider({
        baseUrl: config.ANSWER_GENERATION_BASE_URL,
        model: config.ANSWER_GENERATION_MODEL,
        ...(localApiKey ? { apiKey: localApiKey } : {}),
        timeoutMs: config.ANSWER_GENERATION_TIMEOUT_MS,
        maxTokens: config.ANSWER_GENERATION_MAX_TOKENS,
        reasoningEffort: config.ANSWER_GENERATION_REASONING_EFFORT,
        thinkingTokenBudget: config.ANSWER_GENERATION_THINKING_TOKEN_BUDGET,
        responseStyle: "quotes",
        protocol: "vllm",
      }, fetcher)
      : null,
  );
  for (const entry of openAiAnswerModels) {
    // Zachování původní konfigurace starší volby; nové volby mají vlastní pevné API ID.
    const model = entry.id === "gpt-5.6-luna" ? config.OPENAI_ANSWER_MODEL : entry.id;
    const minimumReasoningEffort = model === "gpt-6.1-sol" ? "low" : "none";
    providers.set(
      entry.id,
      config.OPENAI_API_KEY
        ? new OpenAiCompatibleAnswerProvider({
          baseUrl: "https://api.openai.com/v1",
          model,
          apiKey: config.OPENAI_API_KEY,
          timeoutMs: config.OPENAI_ANSWER_TIMEOUT_MS,
          maxTokens: config.OPENAI_ANSWER_MAX_TOKENS,
          reasoningEffort: config.OPENAI_ANSWER_REASONING_EFFORT === "none"
            ? minimumReasoningEffort
            : config.OPENAI_ANSWER_REASONING_EFFORT,
          minimumReasoningEffort,
          thinkingTokenBudget: 0,
          protocol: "openai",
        }, fetcher)
        : null,
    );
  }
  return providers;
}
