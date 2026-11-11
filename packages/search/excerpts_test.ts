import { assertEquals } from "@std/assert";
import { isRepetitiveExcerpt, selectDiverseExcerpts } from "./excerpts.ts";

const sentence = "Marek Benda zakázal lidem z ODS komunikovat s Deníkem N.";
const excerpt = (episodeId: string, text: string, startSeconds = 0, endSeconds = 30) => ({
  episodeId,
  text,
  startSeconds,
  endSeconds,
});

Deno.test("podklady vynechají dlouhou ASR smyčku, zachovají krátké opakování", () => {
  assertEquals(isRepetitiveExcerpt(sentence.repeat(12)), true);
  assertEquals(isRepetitiveExcerpt(sentence + sentence), false);
  assertEquals(
    selectDiverseExcerpts([
      excerpt("a", sentence.repeat(12)),
      excerpt("a", sentence, 10, 20),
      excerpt("a", sentence, 300, 320),
    ], 16).map((source) => source.startSeconds),
    [300],
  );
});

Deno.test("podklady omezí překryvy i textové duplicity v různých vydáních", () => {
  const independent = excerpt("a", "Další odlišné téma se týká transparentnosti médií.", 200, 230);
  const selected = selectDiverseExcerpts([
    excerpt("a", sentence),
    excerpt("a", "Jiná část stejného překrývajícího se úryvku.", 10, 35),
    excerpt("b", sentence.toUpperCase()),
    independent,
    excerpt("c", "Sponzoring médií je předmětem jiné diskuse."),
    excerpt("a", "Třetí samostatná pasáž o vztahu tisku a politiky.", 400, 430),
  ], 16);
  assertEquals(selected.map((source) => [source.episodeId, source.startSeconds]), [
    ["a", 0],
    ["c", 0],
    ["a", 200],
  ]);
});

Deno.test("výběr konkrétní epizody umožní více než dvě samostatné pasáže", () => {
  const sources = [
    excerpt("a", "První rozdílná věta o politice.", 0, 10),
    excerpt("a", "Druhá samostatná zpráva o ekonomice.", 30, 40),
    excerpt("a", "Třetí nezávislá informace ze sportu.", 60, 70),
  ];
  assertEquals(selectDiverseExcerpts(sources, 16, 16), sources);
  assertEquals(selectDiverseExcerpts(sources, 1).length, 1);
  assertEquals(selectDiverseExcerpts([], 16), []);
});
