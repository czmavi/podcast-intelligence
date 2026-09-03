import { assertEquals, assertThrows } from "@std/assert";
import { assertTransition, canTransition } from "./state-machine.ts";

Deno.test("stavový automat povolí další krok pipeline", () => {
  assertEquals(canTransition("imported", "download_queued"), true);
  assertTransition("normalizing", "normalized");
});

Deno.test("stavový automat odmítne přeskočení kroku", () => {
  assertEquals(canTransition("imported", "ready"), false);
  assertThrows(() => assertTransition("imported", "ready"));
});
