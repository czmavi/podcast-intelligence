import { assertEquals } from "@std/assert";
import { detectDirectAddresses } from "./direct-address.ts";

Deno.test("detekuje přímé oslovení očekávaného účastníka", () => {
  const result = detectDirectAddresses(
    "Pavle, jak to vidíte vy?",
    42,
    "cluster-b",
    [{ personId: "person-pavel", displayName: "Pavel Novák" }],
  );
  assertEquals(result[0]?.personId, "person-pavel");
  assertEquals(result[0]?.nextSpeakerClusterId, "cluster-b");
});
