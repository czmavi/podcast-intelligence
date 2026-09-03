const namedEntities: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  "#39": "'",
  quot: '"',
};

export function htmlToPlainText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const decoded = String(value).replace(
    /&(nbsp|amp|lt|gt|#39|quot);/gi,
    (entity, name: string) => namedEntities[name.toLowerCase()] ?? entity,
  );
  return decoded
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}
