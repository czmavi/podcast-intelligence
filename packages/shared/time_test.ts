import { assertEquals } from "@std/assert";
import { formatTimestamp } from "./time.ts";

Deno.test("formátuje timestamp včetně hodin", () => {
  assertEquals(formatTimestamp(1523.9), "00:25:23");
  assertEquals(formatTimestamp(3723), "01:02:03");
});
