import { isAbsolute, relative, resolve } from "@std/path";
import { DomainError } from "../domain/errors.ts";

export function safeStoragePath(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (
      !segment || segment === "." || segment === ".." || segment.includes("/") ||
      segment.includes("\\")
    ) {
      throw new DomainError("Neplatný segment storage cesty.", "INVALID_STORAGE_PATH");
    }
  }
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...segments);
  const rel = relative(absoluteRoot, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DomainError("Storage cesta opouští povolený kořen.", "INVALID_STORAGE_PATH");
  }
  return candidate;
}

export function episodeStorage(root: string, podcastId: string, episodeId: string) {
  const base = safeStoragePath(root, "podcasts", podcastId, "episodes", episodeId);
  return {
    base,
    original: safeStoragePath(base, "original"),
    normalized: safeStoragePath(base, "normalized"),
    derived: safeStoragePath(base, "derived"),
  };
}

export function toSharedStoragePath(
  localRoot: string,
  sharedRoot: string,
  localPath: string,
): string {
  const absoluteLocalRoot = resolve(localRoot);
  const absoluteLocalPath = resolve(localPath);
  const rel = relative(absoluteLocalRoot, absoluteLocalPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DomainError("Soubor leží mimo lokální storage root.", "INVALID_STORAGE_PATH");
  }
  return resolve(sharedRoot, rel);
}
