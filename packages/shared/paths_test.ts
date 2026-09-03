import { assertEquals, assertThrows } from "@std/assert";
import { safeStoragePath, toSharedStoragePath } from "./paths.ts";

Deno.test("safeStoragePath skládá cestu uvnitř rootu", () => {
  assertEquals(safeStoragePath("/data", "podcasts", "abc"), "/data/podcasts/abc");
});

Deno.test("safeStoragePath odmítne traversal", () => {
  assertThrows(() => safeStoragePath("/data", ".."));
  assertThrows(() => safeStoragePath("/data", "a/b"));
});

Deno.test("převede absolutní lokální cestu na ML shared root", () => {
  assertEquals(
    toSharedStoragePath(
      "/workspace/storage",
      "/data",
      "/workspace/storage/podcasts/a/audio.wav",
    ),
    "/data/podcasts/a/audio.wav",
  );
  assertThrows(() => toSharedStoragePath("/workspace/storage", "/data", "/workspace/secrets.txt"));
});
