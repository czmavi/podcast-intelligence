import { assert, assertEquals } from "@std/assert";
import { nameQuery } from "./names.ts";

Deno.test("jména mají obecné tvary příjmení bez výjimek pro konkrétní politiky", () => {
  for (
    const [query, forms] of [
      ["Donald Trump", ["trump", "trumpa", "trumpovi"]],
      ["Kamala Harris", ["harris", "harrisovou"]],
      ["Petr Fiala", ["fiala", "fialovi", "fialy"]],
      ["Andrej Babiš", ["babis", "babise", "babisovi"]],
      ["Miloš Zeman", ["zeman", "zemanem"]],
      ["Petr Pavel", ["pavel", "pavla", "pavlem"]],
      ["Robert Fico", ["fico"]],
    ] as const
  ) {
    const plan = nameQuery(query);
    assert(plan, query);
    for (const form of forms) {
      assert(plan.surnameQuery.split(" | ").includes(form), `${query}: ${form}`);
    }
  }
});

Deno.test("rozpoznání jmen zachovává obecná témata a doplňuje neznámá jména z katalogu", () => {
  for (
    const query of [
      "Česká televize",
      "Deník N",
      "Nová naděje",
      "veřejné finance",
      "Petr",
      "Petr Fiala vláda",
      "Petr | Fiala",
      "neznámý člověk",
    ]
  ) {
    assertEquals(nameQuery(query), null);
  }
  assertEquals(nameQuery("Keanu Reeves"), null);
  assertEquals(nameQuery("keanu reeves", ["Keanu Reeves"])?.given, "keanu");
  assertEquals(nameQuery("donald trump")?.given, "donald");
  assertEquals(nameQuery("Donalda Trumpa")?.given, "donald");
  assertEquals(nameQuery("Donald Trump")?.surnameQuery.includes("trumpova"), false);
  assertEquals(nameQuery("Petr Novák")?.surnameQuery.includes("novakova"), false);
});
