import { XMLParser } from "fast-xml-parser";
import { htmlToPlainText } from "../shared/text.ts";

export interface ParsedEpisode {
  externalId: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  audioUrl: string;
  sourceUrl: string | null;
  durationSeconds: number | null;
  audioMimeType: string | null;
  audioByteSize: number | null;
}

export interface ParsedPodcast {
  name: string;
  websiteUrl: string | null;
  description: string | null;
  imageUrl: string | null;
  episodes: ParsedEpisode[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

export function parseDuration(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) {
    return null;
  }
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  if (hours === undefined || minutes === undefined || seconds === undefined) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function absoluteHttpUrl(value: unknown, baseUrl: string): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function stableExternalId(
  guid: string | null,
  audioUrl: string,
  title: string,
  publishedAt: string | null,
): Promise<string> {
  if (guid) return guid;
  const input = new TextEncoder().encode(`${audioUrl}\n${title}\n${publishedAt ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `sha256:${
    Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

export async function parsePodcastRss(xml: string, feedUrl: string): Promise<ParsedPodcast> {
  if (xml.length > 20_000_000) throw new Error("RSS feed je příliš velký.");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    processEntities: false,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (!channel || !text(channel.title)) {
    throw new Error("Dokument není platný podcastový RSS feed.");
  }

  const episodes: ParsedEpisode[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(channel.item as Record<string, unknown> | Record<string, unknown>[])) {
    const enclosure = raw.enclosure as Record<string, unknown> | undefined;
    const audioUrl = absoluteHttpUrl(enclosure?.["@_url"], feedUrl);
    if (!audioUrl) continue;
    const mime = text(enclosure?.["@_type"]);
    if (mime && !mime.startsWith("audio/") && mime !== "application/octet-stream") continue;
    const title = text(raw.title) ?? "Epizoda bez názvu";
    const dateRaw = text(raw.pubDate) ?? text(raw["dc:date"]);
    const parsedDate = dateRaw ? new Date(dateRaw) : null;
    const publishedAt = parsedDate && !Number.isNaN(parsedDate.valueOf())
      ? parsedDate.toISOString()
      : null;
    const externalId = await stableExternalId(text(raw.guid), audioUrl, title, publishedAt);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const lengthRaw = text(enclosure?.["@_length"]);
    const length = lengthRaw ? Number(lengthRaw) : null;
    episodes.push({
      externalId,
      title,
      description: htmlToPlainText(text(raw["content:encoded"]) ?? text(raw.description)),
      publishedAt,
      audioUrl,
      sourceUrl: absoluteHttpUrl(raw.link, feedUrl),
      durationSeconds: parseDuration(raw["itunes:duration"]),
      audioMimeType: mime,
      audioByteSize: length !== null && Number.isSafeInteger(length) && length >= 0 ? length : null,
    });
  }
  if (episodes.length === 0) {
    throw new Error("RSS feed neobsahuje žádné podporované audio enclosure.");
  }

  const itunesImage = channel["itunes:image"];
  const standardImage = channel.image as Record<string, unknown> | undefined;
  const itunesImageValue = itunesImage && typeof itunesImage === "object"
    ? (itunesImage as Record<string, unknown>)["@_href"]
    : itunesImage;
  return {
    name: text(channel.title) ?? "Podcast",
    websiteUrl: absoluteHttpUrl(channel.link, feedUrl),
    description: htmlToPlainText(text(channel.description)),
    imageUrl: absoluteHttpUrl(itunesImageValue, feedUrl) ??
      absoluteHttpUrl(standardImage?.url, feedUrl),
    episodes,
  };
}
