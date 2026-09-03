import { z } from "zod";

const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.string().url().default("http://localhost:8000"),
  DATABASE_URL: z.string().url().default("postgres://podcast:podcast@localhost:5432/podcast"),
  STORAGE_ROOT: z.string().min(1).default("./storage"),
  AUDIO_ML_URL: z.string().url().default("http://localhost:8001"),
  AUDIO_ML_API_TOKEN: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(32).optional(),
  ),
  AUDIO_ML_SHARED_ROOT: z.string().min(1).default("/data"),
  AUDIO_ML_IDLE_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  DEFAULT_TRANSCRIPTION_LANGUAGE: z.string().min(2).default("cs"),
  TEXT_EMBEDDING_PROVIDER: z.enum(["local", "openai"]).default("local"),
  TEXT_EMBEDDING_MODEL: z.string().default(
    "BAAI/bge-m3",
  ),
  TEXT_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  TEXT_RERANKER_MODEL: z.string().default("BAAI/bge-reranker-v2-m3"),
  SEARCH_CANDIDATE_LIMIT: z.coerce.number().int().min(10).max(100).default(50),
  SEARCH_MIN_RERANK_SCORE: z.coerce.number().min(0).max(1).default(0.2),
  SPEAKER_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(256),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  DOWNLOAD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  AUTO_PROCESS_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  MAX_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  PUSHOVER_APP_TOKEN: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(20).optional(),
  ),
  PUSHOVER_USER_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(20).optional(),
  ),
  PUSHOVER_NOTIFICATION_COOLDOWN_MS: z.coerce.number().int().min(60_000).max(604_800_000)
    .default(10_800_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AUTH_MODE: z.enum(["disabled", "header"]).default("disabled"),
  AUTH_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ANSWER_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  OPENAI_ANSWER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  OPENAI_ANSWER_MAX_TOKENS: z.coerce.number().int().min(128).max(131_072).default(4000),
  OPENAI_ANSWER_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"])
    .default("low"),
  ANSWER_GENERATION_PROVIDER: z.enum(["disabled", "openai-compatible"]).default("disabled"),
  ANSWER_GENERATION_BASE_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().optional(),
  ),
  ANSWER_GENERATION_MODEL: z.string().min(1).default(
    "bottlecapai/ThinkingCap-Qwen3.6-27B-NVFP4",
  ),
  ANSWER_GENERATION_API_KEY: z.string().optional(),
  ANSWER_GENERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  ANSWER_GENERATION_MAX_TOKENS: z.coerce.number().int().min(128).max(8192).default(500),
  ANSWER_GENERATION_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("none"),
  ANSWER_GENERATION_THINKING_TOKEN_BUDGET: z.coerce.number().int().min(0).max(8192).default(2048),
  ASR_CORRECTION_MODEL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).optional(),
  ),
  ASR_CORRECTION_AUTO_APPLY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  ASR_CORRECTION_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ASR_CORRECTION_CONTEXT_SIZE: z.coerce.number().int().min(15).max(600).default(90),
}).superRefine((config, context) => {
  if (
    config.ANSWER_GENERATION_PROVIDER === "openai-compatible" &&
    !config.ANSWER_GENERATION_BASE_URL
  ) {
    context.addIssue({
      code: "custom",
      path: ["ANSWER_GENERATION_BASE_URL"],
      message: "je povinná pro openai-compatible provider",
    });
  }
  if (Boolean(config.PUSHOVER_APP_TOKEN) !== Boolean(config.PUSHOVER_USER_KEY)) {
    context.addIssue({
      code: "custom",
      path: [config.PUSHOVER_APP_TOKEN ? "PUSHOVER_USER_KEY" : "PUSHOVER_APP_TOKEN"],
      message: "Pushover token aplikace a uživatelský klíč musí být nastavené společně",
    });
  }
  if (
    config.ANSWER_GENERATION_REASONING_EFFORT !== "none" &&
    config.ANSWER_GENERATION_THINKING_TOKEN_BUDGET > 0 &&
    config.ANSWER_GENERATION_THINKING_TOKEN_BUDGET >= config.ANSWER_GENERATION_MAX_TOKENS
  ) {
    context.addIssue({
      code: "custom",
      path: ["ANSWER_GENERATION_THINKING_TOKEN_BUDGET"],
      message: "musí být menší než ANSWER_GENERATION_MAX_TOKENS",
    });
  }
});

export type Config = z.infer<typeof envSchema>;

export function answerGenerationApiKey(
  config: Pick<Config, "ANSWER_GENERATION_API_KEY" | "AUDIO_ML_API_TOKEN">,
): string | undefined {
  return config.ANSWER_GENERATION_API_KEY || config.AUDIO_ML_API_TOKEN;
}

export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Neplatná konfigurace: ${details}`);
  }
  if (result.data.AUTH_MODE === "header" && !result.data.AUTH_TOKEN) {
    throw new Error("Neplatná konfigurace: AUTH_TOKEN je povinný pro AUTH_MODE=header.");
  }
  return result.data;
}
