import { foldSearchText } from "./query.ts";

interface Excerpt {
  episodeId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

function fingerprints(text: string): { phrases: Set<string>; count: number } {
  const words = foldSearchText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 5) return { phrases: new Set([words.join(" ")]), count: 1 };
  const phrases = words.slice(4).map((_, index) => words.slice(index, index + 5).join(" "));
  return { phrases: new Set(phrases), count: phrases.length };
}

export function isRepetitiveExcerpt(text: string): boolean {
  const { phrases, count } = fingerprints(text);
  // Krátké opakování pro důraz zachováme; dlouhé ASR smyčky nejsou spolehlivý podklad.
  return count >= 30 && phrases.size / count < 0.45;
}

function duplicates(left: Excerpt, right: Excerpt): boolean {
  if (left.episodeId === right.episodeId) {
    const overlap = Math.min(left.endSeconds, right.endSeconds) -
      Math.max(left.startSeconds, right.startSeconds);
    const duration = Math.min(
      left.endSeconds - left.startSeconds,
      right.endSeconds - right.startSeconds,
    );
    if (overlap > 0 && overlap >= duration * 0.5) return true;
  }
  const a = fingerprints(left.text).phrases;
  const b = fingerprints(right.text).phrases;
  const shared = [...a].filter((phrase) => b.has(phrase)).length;
  return shared / Math.max(1, Math.min(a.size, b.size)) >= 0.75;
}

/** Nejdřív různé díly, potom další nezávislé pasáže; původní texty se nepřepisují. */
export function selectDiverseExcerpts<T extends Excerpt>(
  candidates: T[],
  limit: number,
  perEpisodeLimit = 2,
): T[] {
  const selected: T[] = [];
  const counts = new Map<string, number>();
  const loops = candidates.filter((candidate) => isRepetitiveExcerpt(candidate.text));
  const usable = candidates.filter((candidate) =>
    !loops.some((loop) =>
      loop.episodeId === candidate.episodeId &&
      candidate.startSeconds < loop.endSeconds && candidate.endSeconds > loop.startSeconds
    )
  );
  for (let round = 1; round <= perEpisodeLimit && selected.length < limit; round += 1) {
    for (const candidate of usable) {
      if ((counts.get(candidate.episodeId) ?? 0) >= round) continue;
      if (selected.some((previous) => duplicates(previous, candidate))) continue;
      selected.push(candidate);
      counts.set(candidate.episodeId, (counts.get(candidate.episodeId) ?? 0) + 1);
      if (selected.length === limit) break;
    }
  }
  return selected;
}
