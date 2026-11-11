import { assertEquals } from "@std/assert";
import { searchPlanSchema } from "./plan.ts";

Deno.test("plán nepřijímá filtry formuláře, prázdné podmínky ani neomezené větvení", () => {
  const person = { personMention: "Kamala Harris" };
  const valid = { match: { any: [person] }, prefer: [{ topic: "volb" }], coverage: "each_branch" };
  assertEquals(searchPlanSchema.safeParse(valid).success, true);
  for (
    const invalid of [
      { ...valid, personId: "someone else" },
      { ...valid, match: { any: [person], all: [person] } },
      { ...valid, match: { all: [] } },
      { ...valid, match: { any: Array(5).fill(person) } },
      { ...valid, match: { any: [{ sql: "SELECT 1" }] } },
      { ...valid, match: { all: [{ topic: "&:*" }] } },
    ]
  ) assertEquals(searchPlanSchema.safeParse(invalid).success, false);
});
