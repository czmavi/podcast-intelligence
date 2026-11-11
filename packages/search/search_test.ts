import { assertEquals } from "@std/assert";
import { lexicalTerms, passesRerank, rerankThreshold } from "./search.ts";
import {
  answerSearchQuery,
  comparisonSearchQueries,
  normalizedLexicalTerms,
  normalizedTsQuery,
} from "./query.ts";

Deno.test("lexicalTerms odstraní obecný požadavek na citaci", () => {
  assertEquals(lexicalTerms("citace Miloš Zeman"), ["miloš", "zeman"]);
});

Deno.test("lexicalTerms zachová dotaz složený jen z obecného slova", () => {
  assertEquals(lexicalTerms("citace"), ["citace"]);
});

Deno.test("otázka nad zdroji hledá téma a mluvčího ponechá jako filtr", () => {
  assertEquals(
    answerSearchQuery("Co Michal Půr říká o Martinu Voháňkovi?", "Michal Půr"),
    "Martinu Voháňkovi",
  );
  assertEquals(
    answerSearchQuery("Co říkal o Martinu Voháňkovi?", "Michal Půr"),
    "Martinu Voháňkovi",
  );
});

Deno.test("hodnocení a názor nejsou povinná slova zdrojového úryvku", () => {
  for (
    const question of [
      "Jak hodnotí deník n",
      "Jak Michal Půr hodnotí Deník N?",
      "Jak hodnotil Deník N?",
      "Jak hodnotila Deník N?",
      "Jaký má názor na Deník N?",
      "Co si myslí o Deníku N?",
      "Jak se staví k Deníku N?",
      "Jak komentuje Deník N?",
      "Vyjádřil se k Deníku N?",
      "Jak Michal Půr hodnotí Deník N a jak se jeho názor v čase měnil?",
      "Jak hodnotí Deník N a jak se její postoj postupem času změnil?",
    ]
  ) {
    assertEquals(
      normalizedTsQuery(answerSearchQuery(question, "Michal Půr")),
      "denik:* & n",
      question,
    );
  }
});

Deno.test("zjednodušení otázky zachová konkrétní téma i dotaz bez rozpoznaného tématu", () => {
  assertEquals(answerSearchQuery("Jak hodnotí financování Deníku N?"), "financování Deníku N");
  assertEquals(answerSearchQuery("Co říká o změnách klimatu v čase?"), "změnách klimatu v čase");
  assertEquals(answerSearchQuery("Jak hodnotí?"), "Jak hodnotí?");
  assertEquals(answerSearchQuery("Deník N"), "Deník N");
});

Deno.test("normalizovaný fulltext zvládne pád i odlišnou diakritiku jména", () => {
  assertEquals(normalizedLexicalTerms("Martinu Voháňkovi"), ["martin", "vohank"]);
  assertEquals(normalizedTsQuery("Co? Deníku N!"), "co & denik:* & n");
});

Deno.test("přesnost mění minimální skóre rerankeru", () => {
  assertEquals(rerankThreshold("strict", 0.2), 0.5);
  assertEquals(rerankThreshold("balanced", 0.2), 0.2);
  assertEquals(rerankThreshold("related", 0.2), 0.05);
});

Deno.test("doslovná shoda projde i pod prahem rerankeru", () => {
  assertEquals(passesRerank("balanced", 0.01, 1, 0.2), true);
  assertEquals(passesRerank("balanced", 0.01, 0, 0.2), false);
});

Deno.test("srovnání hledá obě osoby samostatně pod příjmením", () => {
  for (const separator of ["vs", "VS.", "versus", "proti"]) {
    assertEquals(
      comparisonSearchQueries(answerSearchQuery(
        `Jaký má Michal Půr názor na Donald Trump ${separator} Kamala Harris?`,
        "Michal Půr",
      )),
      ["Donald Trump", "Kamala Harris"],
    );
  }
  assertEquals(comparisonSearchQueries("Donalda Trumpa vs Kamalu Harrisovou"), [
    "Donalda Trumpa",
    "Kamalu Harrisovou",
  ]);
  assertEquals(comparisonSearchQueries("Trump vs Harris"), ["Trump", "Harris"]);
  assertEquals(comparisonSearchQueries("Deník N vs Česká televize"), ["Deník N", "Česká televize"]);
  for (
    const query of ["Deník N", "Donald Trump Kamala Harris", "vs Harris", "Trump vs", "A vs B vs C"]
  ) {
    assertEquals(comparisonSearchQueries(query), null);
  }
});
