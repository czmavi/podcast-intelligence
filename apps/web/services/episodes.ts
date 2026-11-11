import { type EpisodeStatus, episodeStatuses } from "../../../packages/domain/entities.ts";
import { escapeHtml } from "./html.ts";

export const episodeFilterValues = [
  "not_downloaded",
  "queued",
  "processing",
  "ready",
  "failed",
  "skipped",
] as const;

export type EpisodeFilter = (typeof episodeFilterValues)[number];

export const episodeFilterLabels: Record<EpisodeFilter, string> = {
  not_downloaded: "Nestáhnuto",
  queued: "Ve frontě",
  processing: "Zpracovává se",
  ready: "Hotovo",
  failed: "Chyba",
  skipped: "Přeskočený",
};

const episodeStatusesByFilter: Record<EpisodeFilter, readonly EpisodeStatus[]> = {
  not_downloaded: ["new", "imported"],
  queued: [
    "download_queued",
    "normalization_queued",
    "transcription_queued",
    "speaker_identification_pending",
    "indexing_queued",
  ],
  processing: [
    "downloading",
    "downloaded",
    "normalizing",
    "normalized",
    "transcribing",
    "transcribed",
    "indexing",
  ],
  ready: ["ready"],
  failed: ["failed"],
  skipped: [],
};

const repeatableStatuses = new Set<EpisodeStatus>(
  episodeStatuses.filter((status) => status !== "new" && status !== "imported"),
);

function isEpisodeStatus(value: string): value is EpisodeStatus {
  return (episodeStatuses as readonly string[]).includes(value);
}

export function episodeStatusesForFilter(filter: EpisodeFilter): readonly EpisodeStatus[] {
  return episodeStatusesByFilter[filter];
}

export function episodeFilterForStatus(statusValue: unknown): EpisodeFilter | null {
  const status = String(statusValue);
  if (!isEpisodeStatus(status)) return null;
  return episodeFilterValues.find((filter) => episodeStatusesByFilter[filter].includes(status)) ??
    null;
}

export function episodeStatusBadge(statusValue: unknown, speakerReviewSkipped = false): string {
  if (speakerReviewSkipped) {
    return '<span class="badge badge-neutral" title="Přeskočený při přiřazování hlasů">Přeskočený</span>';
  }
  const status = String(statusValue);
  const filter = episodeFilterForStatus(status);
  const appearance: Record<EpisodeFilter, string> = {
    not_downloaded: "badge-info",
    queued: "badge-neutral",
    processing: "badge-warning",
    ready: "badge-success",
    failed: "badge-danger",
    skipped: "badge-neutral",
  };
  if (!filter) {
    return `<span class="badge badge-neutral" title="${escapeHtml(status)}">Neznámý stav</span>`;
  }
  return `<span class="badge ${appearance[filter]}" title="${escapeHtml(status)}">${
    episodeFilterLabels[filter]
  }</span>`;
}

export function episodeSpeakerAssignmentBadge(
  totalSpeakerCountValue: unknown,
  verifiedSpeakerCountValue: unknown,
): string {
  const total = Math.max(0, Number(totalSpeakerCountValue) || 0);
  const verified = Math.max(0, Number(verifiedSpeakerCountValue) || 0);
  const missing = Math.max(0, total - verified);
  if (total === 0 || missing === 0) return "";
  const label = `Nepřiřazené hlasy: ${missing}/${total}`;
  return `<span class="badge badge-warning" title="${escapeHtml(label)}">${label}</span>`;
}

export function nextSpeakerAssignmentEpisodeLink(episodeIdValue: unknown): string {
  if (!episodeIdValue) return "";
  return `<div class="speaker-navigation">
    <a class="button" href="/episodes/${escapeHtml(episodeIdValue)}">Další díl →</a>
  </div>`;
}

export function episodeSpeakerReviewControl(episodeIdValue: unknown, skipped: boolean): string {
  const endpoint = `/api/episodes/${escapeHtml(episodeIdValue)}/speaker-review`;
  if (skipped) {
    return `<div class="alert alert-info"><strong>Díl je přeskočený.</strong>
      Nebude se nabízet jako další díl k přiřazení hlasů. Přepis a přiřazení zůstávají uložené.
      <button class="secondary" data-action="${endpoint}" data-method="PATCH"
        data-body='{"skipped":false}'>Vrátit k přiřazování hlasů</button></div>`;
  }
  return `<button class="secondary" data-action="${endpoint}" data-method="PATCH"
    data-body='{"skipped":true}'>Přeskočit díl</button>`;
}

export function formatEpisodePublishedDate(value: unknown): string {
  if (!value) return "Datum vydání není k dispozici";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Datum vydání není k dispozici";
  return new Intl.DateTimeFormat("cs-CZ", {
    dateStyle: "long",
    timeZone: "Europe/Prague",
  }).format(date);
}

export function isVerifiedSpeakerAssignment(
  assignedPersonIdValue: unknown,
  identityStatusValue: unknown,
): boolean {
  return Boolean(assignedPersonIdValue) && String(identityStatusValue) === "verified";
}

export function isCompactSpeakerCard(
  assignedPersonIdValue: unknown,
  identityStatusValue: unknown,
): boolean {
  return String(identityStatusValue) === "ignored" ||
    isVerifiedSpeakerAssignment(assignedPersonIdValue, identityStatusValue);
}

export function episodeRagExclusionControl(
  episodeIdValue: unknown,
  excludedValue: unknown,
): string {
  const episodeId = escapeHtml(episodeIdValue);
  const excluded = excludedValue === true;
  const button = excluded
    ? `<button class="secondary" data-action="/api/episodes/${episodeId}/rag-exclusion"
        data-method="PATCH" data-body='{"excluded":false}'>Znovu povolit RAG</button>`
    : `<button class="secondary" data-action="/api/episodes/${episodeId}/rag-exclusion"
        data-method="PATCH" data-body='{"excluded":true}'
        data-confirm="Epizoda se přestane zobrazovat ve vyhledávání. Přepis, chunky, identifikace hlasů a další odvozená textová data budou smazána; audio zůstane zachované."
        data-confirm-label="Ano, vyloučit">Vyloučit z RAG</button>`;
  const warning = excluded
    ? `<div class="alert alert-warning"><strong>Vyloučeno z RAG.</strong>
        Epizoda se nepoužívá ve vyhledávání ani jako zdroj odpovědí. Přepis a identifikace hlasů byly smazány, audio zůstalo zachované. Po opětovném povolení spusťte nový přepis.</div>`
    : "";
  return `${button}${warning}`;
}

export interface EpisodeActionAppearance {
  className: "" | "secondary" | "danger-action";
  label: "Zpracovat" | "Opakovat";
}

export function episodeActionConfirmation(statusValue: unknown): string | null {
  return String(statusValue) === "ready"
    ? "Vytvoří se nová varianta přepisu. Původní přepis i přiřazení hlasů zůstanou uložené. " +
      "Po dokončení vyberete, kterou variantu použít. Pokračovat?"
    : null;
}

export function episodeActionAppearance(
  statusValue: unknown,
  hasOriginalAudio: boolean,
): EpisodeActionAppearance {
  const status = String(statusValue);
  if (status === "failed") {
    return { className: "danger-action", label: "Opakovat" };
  }
  if (hasOriginalAudio || (isEpisodeStatus(status) && repeatableStatuses.has(status))) {
    return { className: "secondary", label: "Opakovat" };
  }
  return { className: "", label: "Zpracovat" };
}
