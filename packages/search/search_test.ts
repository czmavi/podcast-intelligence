import { assertEquals } from "@std/assert";
import { lexicalTerms, passesRerank, rerankThreshold } from "./search.ts";
import { answerSearchQuery, normalizedLexicalTerms } from "./query.ts";

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

Deno.test("normalizovaný fulltext zvládne pád i odlišnou diakritiku jména", () => {
  assertEquals(normalizedLexicalTerms("Martinu Voháňkovi"), ["martin", "vohank"]);
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
