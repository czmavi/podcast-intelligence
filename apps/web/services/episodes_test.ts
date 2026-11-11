import { assertEquals, assertStringIncludes } from "@std/assert";
import { episodeStatuses } from "../../../packages/domain/entities.ts";
import {
  episodeActionAppearance,
  episodeActionConfirmation,
  episodeFilterForStatus,
  episodeFilterValues,
  episodeRagExclusionControl,
  episodeSpeakerAssignmentBadge,
  episodeSpeakerReviewControl,
  episodeStatusBadge,
  episodeStatusesForFilter,
  formatEpisodePublishedDate,
  isCompactSpeakerCard,
  isVerifiedSpeakerAssignment,
  nextSpeakerAssignmentEpisodeLink,
} from "./episodes.ts";

Deno.test("nestáhnutá epizoda má informační štítek a primární akci", () => {
  assertStringIncludes(episodeStatusBadge("imported"), "badge-info");
  assertStringIncludes(episodeStatusBadge("imported"), "Nestáhnuto");
  assertEquals(episodeActionAppearance("imported", false), {
    className: "",
    label: "Zpracovat",
  });
});

Deno.test("probíhající a stažená epizoda nabízí sekundární opakování", () => {
  assertEquals(episodeActionAppearance("downloading", false), {
    className: "secondary",
    label: "Opakovat",
  });
  assertEquals(episodeActionAppearance("ready", true), {
    className: "secondary",
    label: "Opakovat",
  });
});

Deno.test("opakování hotové epizody vyžaduje potvrzení", () => {
  assertStringIncludes(episodeActionConfirmation("ready") ?? "", "nová varianta přepisu");
  assertEquals(episodeActionConfirmation("failed"), null);
  assertEquals(episodeActionConfirmation("transcribing"), null);
});

Deno.test("chybná epizoda nabízí červené opakování", () => {
  assertEquals(episodeActionAppearance("failed", false), {
    className: "danger-action",
    label: "Opakovat",
  });
});

Deno.test("stavy ve frontě jsou oddělené od probíhajícího zpracování", () => {
  assertEquals(episodeFilterForStatus("download_queued"), "queued");
  assertEquals(episodeFilterForStatus("speaker_identification_pending"), "queued");
  assertStringIncludes(episodeStatusBadge("indexing_queued"), "Ve frontě");

  for (
    const status of [
      "downloading",
      "downloaded",
      "normalizing",
      "normalized",
      "transcribing",
      "transcribed",
      "indexing",
    ]
  ) {
    assertEquals(episodeFilterForStatus(status), "processing");
    assertStringIncludes(episodeStatusBadge(status), "Zpracovává se");
  }
});

Deno.test("uživatelské filtry pokrývají každý interní stav právě jednou", () => {
  const groupedStatuses = episodeFilterValues.flatMap((filter) => [
    ...episodeStatusesForFilter(filter),
  ]);
  assertEquals(new Set(groupedStatuses).size, episodeStatuses.length);
  assertEquals([...groupedStatuses].sort(), [...episodeStatuses].sort());
});

Deno.test("štítek upozorní jen na detekované a nepotvrzené hlasy", () => {
  assertEquals(episodeSpeakerAssignmentBadge(0, 0), "");
  assertEquals(episodeSpeakerAssignmentBadge(2, 2), "");
  assertStringIncludes(episodeSpeakerAssignmentBadge(3, 1), "Nepřiřazené hlasy: 2/3");
  assertStringIncludes(episodeSpeakerAssignmentBadge(3, 1), "badge-warning");
});

Deno.test("odkaz na další přiřazování hlasů se vykreslí jen pro nalezenou epizodu", () => {
  assertEquals(nextSpeakerAssignmentEpisodeLink(null), "");
  const link = nextSpeakerAssignmentEpisodeLink("200065d7-a95c-45f8-872c-bb16fd455c9f");
  assertStringIncludes(link, "/episodes/200065d7-a95c-45f8-872c-bb16fd455c9f");
  assertStringIncludes(link, "Další díl →");
});

Deno.test("přeskočený díl má vlastní filtr, štítek a vratné ovládání", () => {
  assertEquals(episodeFilterValues.includes("skipped"), true);
  assertStringIncludes(episodeStatusBadge("ready", true), "Přeskočený");
  assertStringIncludes(episodeSpeakerReviewControl("episode", false), '{"skipped":true}');
  assertStringIncludes(episodeSpeakerReviewControl("episode", true), '{"skipped":false}');
  assertStringIncludes(episodeSpeakerReviewControl("episode", true), "Vrátit k přiřazování hlasů");
});

Deno.test("datum vydání epizody se zobrazí česky a má bezpečný fallback", () => {
  assertEquals(formatEpisodePublishedDate("2026-08-26T12:00:00Z"), "26. srpna 2026");
  assertEquals(formatEpisodePublishedDate(null), "Datum vydání není k dispozici");
  assertEquals(formatEpisodePublishedDate("neplatné"), "Datum vydání není k dispozici");
});

Deno.test("jen ověřené přiřazení hlasu používá kompaktní kartu", () => {
  assertEquals(isVerifiedSpeakerAssignment("person-1", "verified"), true);
  assertEquals(isVerifiedSpeakerAssignment("person-1", "suggested"), false);
  assertEquals(isVerifiedSpeakerAssignment(null, "verified"), false);
});

Deno.test("ignorovaný hlas používá kompaktní kartu i bez osoby", () => {
  assertEquals(isCompactSpeakerCard(null, "ignored"), true);
  assertEquals(isCompactSpeakerCard("person-1", "verified"), true);
  assertEquals(isCompactSpeakerCard(null, "unknown"), false);
});

Deno.test("ovládání RAG vyloučení je vratné a vysvětluje zachování dat", () => {
  const episodeId = "200065d7-a95c-45f8-872c-bb16fd455c9f";
  const included = episodeRagExclusionControl(episodeId, false);
  assertStringIncludes(included, "Vyloučit z RAG");
  assertStringIncludes(included, `data-body='{"excluded":true}'`);

  const excluded = episodeRagExclusionControl(episodeId, true);
  assertStringIncludes(excluded, "Vyloučeno z RAG");
  assertStringIncludes(excluded, "Znovu povolit RAG");
  assertStringIncludes(excluded, "Přepis a identifikace hlasů byly smazány");
  assertStringIncludes(excluded, "audio zůstalo zachované");
});
