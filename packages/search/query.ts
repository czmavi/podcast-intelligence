const answerFramingWords = new Set([
  "co",
  "hodnoti",
  "hodnotil",
  "hodnotila",
  "hodnotili",
  "hodnotily",
  "jak",
  "jaka",
  "jake",
  "jaky",
  "kde",
  "kdo",
  "kdy",
  "k",
  "komentuje",
  "komentuji",
  "komentoval",
  "komentovala",
  "ma",
  "mluvil",
  "mluvila",
  "mluvi",
  "mysli",
  "myslel",
  "myslela",
  "na",
  "nazor",
  "o",
  "ohledne",
  "proc",
  "rekl",
  "rekla",
  "rika",
  "rikaji",
  "rikal",
  "rikala",
  "se",
  "si",
  "stavi",
  "stavel",
  "stavela",
  "tema",
  "tom",
  "tvrdi",
  "tvrdil",
  "tvrdila",
  "vyjadril",
  "vyjadrila",
  "vyjadruje",
  "zminil",
  "zminila",
  "zminuje",
]);

export function foldSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs");
}

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Tento dovětek řídí analýzu vývoje názoru, nemusí být doslova v přepisu.
// Odstraníme celou frázi, nikoli slova „čas“ či „měnil“ uvnitř samotného tématu.
const temporalQuestionTail =
  /(?:^| )a jak se (?:(?:jeho|jeji|jejich) )?(?:nazor|postoj|hodnoceni) (?:v case|postupem casu) (?:meni|menil|menila|menilo|zmenil|zmenila|zmenilo)$/;

/**
 * Oddělí téma, které se má dohledat, od konverzačního rámce otázky.
 * Vybraný mluvčí je databázový filtr, nikoli součást hledaného textu.
 */
export function answerSearchQuery(question: string, selectedSpeakerName?: string): string {
  const speakerWords = new Set(words(selectedSpeakerName ?? "").map(foldSearchText));
  const questionWords = words(question);
  const topicWordCount = words(
    questionWords.map(foldSearchText).join(" ").replace(temporalQuestionTail, ""),
  ).length;
  const focused = questionWords.slice(0, topicWordCount).filter((word) => {
    const normalized = foldSearchText(word);
    return !answerFramingWords.has(normalized) && !speakerWords.has(normalized);
  });
  return focused.length > 0 ? focused.join(" ") : question.trim();
}

function lexicalRoot(term: string): string {
  if (term.length >= 7 && term.endsWith("ovi")) return term.slice(0, -3);
  if (term.length >= 6 && term.endsWith("u")) return term.slice(0, -1);
  return term;
}

/** Kořeny pro prefixový fulltext, např. Martinu Voháňkovi -> martin, vohank. */
export function normalizedLexicalTerms(query: string): string[] {
  return words(foldSearchText(query)).map(lexicalRoot).filter(Boolean);
}

/** Krátké názvy a zkratky (např. N) nesmějí odpovídat začátku libovolného slova. */
export function normalizedTsQuery(query: string): string {
  return normalizedLexicalTerms(query).map((term) => term.length <= 2 ? term : `${term}:*`)
    .join(" & ");
}

/** Explicitní srovnání má dva samostatné okruhy podkladů, nikoli povinnou společnou zmínku. */
export function comparisonSearchQueries(query: string): string[] | null {
  const sides = query.split(/\s+(?:vs\.?|versus|proti)\s+/iu).map((side) => side.trim());
  if (sides.length !== 2 || sides.some((side) => !words(side).length)) return null;
  return sides;
}
