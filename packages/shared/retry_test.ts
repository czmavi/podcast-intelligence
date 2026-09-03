import { assertEquals } from "@std/assert";
import { exponentialBackoffMs } from "./retry.ts";

Deno.test("exponenciální backoff je omezený maximem", () => {
  assertEquals(exponentialBackoffMs(1), 1000);
  assertEquals(exponentialBackoffMs(3), 4000);
  assertEquals(exponentialBackoffMs(20), 300_000);
});
