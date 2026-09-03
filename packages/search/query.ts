const answerFramingWords = new Set([
  "co",
  "jak",
  "jaka",
  "jake",
  "jaky",
  "kde",
  "kdo",
  "kdy",
  "ma",
  "mluvil",
  "mluvila",
  "mluvi",
  "mysli",
  "myslel",
  "myslela",
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
  "tema",
  "tom",
  "tvrdi",
  "tvrdil",
  "tvrdila",
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

/**
 * Oddělí téma, které se má dohledat, od konverzačního rámce otázky.
 * Vybraný mluvčí je databázový filtr, nikoli součást hledaného textu.
 */
export function answerSearchQuery(question: string, selectedSpeakerName?: string): string {
  const speakerWords = new Set(words(selectedSpeakerName ?? "").map(foldSearchText));
  const focused = words(question).filter((word) => {
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
