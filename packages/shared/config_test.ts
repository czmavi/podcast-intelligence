import { assertEquals, assertThrows } from "@std/assert";
import { answerGenerationApiKey, loadConfig } from "./config.ts";

Deno.test("konfigurace poskytuje bezpečné vývojové defaulty", () => {
  const config = loadConfig({});
  assertEquals(config.DEFAULT_TRANSCRIPTION_LANGUAGE, "cs");
  assertEquals(config.MAX_JOB_ATTEMPTS, 3);
  assertEquals(config.WORKER_CONCURRENCY, 1);
  assertEquals(config.DOWNLOAD_WORKER_CONCURRENCY, 2);
  assertEquals(config.AUTO_PROCESS_INTERVAL_MS, 60_000);
  assertEquals(config.AUDIO_ML_IDLE_TIMEOUT_MS, 1_800_000);
  assertEquals(config.ANSWER_GENERATION_REASONING_EFFORT, "none");
  assertEquals(config.OPENAI_ANSWER_MODEL, "gpt-5.6-luna");
  assertEquals(config.OPENAI_ANSWER_REASONING_EFFORT, "low");
  assertEquals(config.OPENAI_ANSWER_MAX_TOKENS, 4000);
  assertEquals(config.PUSHOVER_NOTIFICATION_COOLDOWN_MS, 10_800_000);
  assertEquals(config.ASR_CORRECTION_MODEL, undefined);
  assertEquals(config.ASR_CORRECTION_AUTO_APPLY_THRESHOLD, 0.85);
  assertEquals(config.ASR_CORRECTION_CONCURRENCY, 4);
  assertEquals(config.ASR_CORRECTION_CONTEXT_SIZE, 90);
});

Deno.test("Answer provider sdílí token s Audio ML, pokud nemá vlastní", () => {
  assertEquals(
    answerGenerationApiKey({
      ANSWER_GENERATION_API_KEY: undefined,
      AUDIO_ML_API_TOKEN: "audio-token",
    }),
    "audio-token",
  );
  assertEquals(
    answerGenerationApiKey({
      ANSWER_GENERATION_API_KEY: "answer-token",
      AUDIO_ML_API_TOKEN: "audio-token",
    }),
    "answer-token",
  );
});

Deno.test("idle timeout audio ML nepovolí příliš krátkou hodnotu", () => {
  assertEquals(loadConfig({ AUDIO_ML_IDLE_TIMEOUT_MS: "60000" }).AUDIO_ML_IDLE_TIMEOUT_MS, 60_000);
  assertThrows(
    () => loadConfig({ AUDIO_ML_IDLE_TIMEOUT_MS: "59999" }),
    Error,
    "AUDIO_ML_IDLE_TIMEOUT_MS",
  );
});

Deno.test("interval automatického zpracování má bezpečné meze", () => {
  assertEquals(loadConfig({ AUTO_PROCESS_INTERVAL_MS: "1000" }).AUTO_PROCESS_INTERVAL_MS, 1000);
  assertThrows(
    () => loadConfig({ AUTO_PROCESS_INTERVAL_MS: "999" }),
    Error,
    "AUTO_PROCESS_INTERVAL_MS",
  );
});

Deno.test("souběžnost workeru je omezená na bezpečný rozsah", () => {
  assertEquals(loadConfig({ WORKER_CONCURRENCY: "2" }).WORKER_CONCURRENCY, 2);
  assertEquals(
    loadConfig({ DOWNLOAD_WORKER_CONCURRENCY: "3" }).DOWNLOAD_WORKER_CONCURRENCY,
    3,
  );
  assertThrows(() => loadConfig({ WORKER_CONCURRENCY: "0" }), Error, "WORKER_CONCURRENCY");
  assertThrows(() => loadConfig({ WORKER_CONCURRENCY: "9" }), Error, "WORKER_CONCURRENCY");
  assertThrows(
    () => loadConfig({ DOWNLOAD_WORKER_CONCURRENCY: "0" }),
    Error,
    "DOWNLOAD_WORKER_CONCURRENCY",
  );
});

Deno.test("header auth vyžaduje token", () => {
  assertThrows(() => loadConfig({ AUTH_MODE: "header" }), Error, "AUTH_TOKEN");
});

Deno.test("ML API token musí mít alespoň 32 znaků", () => {
  assertThrows(() => loadConfig({ AUDIO_ML_API_TOKEN: "kratky" }), Error, "AUDIO_ML_API_TOKEN");
});

Deno.test("prázdný ML API token zachová neautentizovaný lokální režim", () => {
  assertEquals(loadConfig({ AUDIO_ML_API_TOKEN: "" }).AUDIO_ML_API_TOKEN, undefined);
});

Deno.test("Pushover vyžaduje oba klíče společně", () => {
  assertThrows(
    () => loadConfig({ PUSHOVER_APP_TOKEN: "a".repeat(30) }),
    Error,
    "PUSHOVER_USER_KEY",
  );
  const config = loadConfig({
    PUSHOVER_APP_TOKEN: "a".repeat(30),
    PUSHOVER_USER_KEY: "u".repeat(30),
  });
  assertEquals(config.PUSHOVER_APP_TOKEN, "a".repeat(30));
});

Deno.test("zapnutý Answer provider vyžaduje URL model serveru", () => {
  assertThrows(
    () => loadConfig({ ANSWER_GENERATION_PROVIDER: "openai-compatible" }),
    Error,
    "ANSWER_GENERATION_BASE_URL",
  );
});

Deno.test("reasoning ponechá tokeny pro finální odpověď", () => {
  assertThrows(
    () =>
      loadConfig({
        ANSWER_GENERATION_REASONING_EFFORT: "high",
        ANSWER_GENERATION_MAX_TOKENS: "1024",
        ANSWER_GENERATION_THINKING_TOKEN_BUDGET: "1024",
      }),
    Error,
    "musí být menší",
  );
});
