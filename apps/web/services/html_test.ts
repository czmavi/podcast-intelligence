import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatByteSize,
  layout,
  podcastSettingsBody,
  podcastSettingsLink,
  storageUsageHtml,
  transcriptLine,
} from "./html.ts";

Deno.test("velikost souborů formátuje v čitelných jednotkách", () => {
  assertEquals(formatByteSize(0), "0 B");
  assertEquals(formatByteSize(1024), "1 kB");
  assertEquals(formatByteSize(1024 * 1024), "1 MB");
});

Deno.test("souhrn úložiště obsahuje tooltip s rozpadem", () => {
  const output = storageUsageHtml({
    storageByteSize: 7 * 1024 * 1024,
    storageAudioByteSize: 5 * 1024 * 1024,
    storageTranscriptByteSize: 1024 * 1024,
    storageOtherByteSize: 1024 * 1024,
  });
  assertStringIncludes(output, "7 MB");
  assertStringIncludes(output, "Audio: 5 MB");
  assertStringIncludes(output, "Přepisy: 1 MB");
  assertStringIncludes(output, "Ostatní: 1 MB");
});

Deno.test("layout obsahuje sdílený potvrzovací dialog", () => {
  const output = layout("Test", "<p>Obsah</p>");
  assertStringIncludes(output, 'id="confirmation-dialog"');
  assertStringIncludes(output, "Potvrdit akci");
  assertStringIncludes(output, "/static/app.css?v=20260831.3");
  assertStringIncludes(output, "/static/app.js?v=20260831.3");
});

Deno.test("detail podcastu odkazuje na samostatné nastavení", () => {
  const output = podcastSettingsLink("200065d7-a95c-45f8-872c-bb16fd455c9f");
  assertStringIncludes(output, "/podcasts/200065d7-a95c-45f8-872c-bb16fd455c9f/settings");
  assertStringIncludes(output, "⚙");
  assertStringIncludes(output, "Nastavení");
});

Deno.test("nastavení podcastu obsahuje všechny přesunuté provozní volby", () => {
  const output = podcastSettingsBody({
    id: "200065d7-a95c-45f8-872c-bb16fd455c9f",
    name: "Testovací podcast",
    rssUrl: "https://example.test/feed.xml",
    lastImportedAt: "2026-08-31T12:00:00Z",
    downloadableEpisodeCount: 3,
    prefetchActiveCount: 1,
    autoProcessEnabled: true,
    autoRefreshEnabled: true,
    transcriptAlignmentMode: "overlap",
  });
  assertStringIncludes(output, "Aktualizovat RSS");
  assertStringIncludes(output, "Stáhnout chybějící díly (3)");
  assertStringIncludes(output, "/auto-refresh");
  assertStringIncludes(output, "Automatická denní aktualizace");
  assertStringIncludes(output, "/auto-processing");
  assertStringIncludes(output, "Automatické zpracování epizod");
  assertStringIncludes(output, 'role="switch"');
  assertStringIncludes(output, "data-automation-status-content");
  assertEquals(output.includes("data-automation-tooltip"), false);
  assertStringIncludes(output, "Uložit diarizaci");
  assertStringIncludes(output, 'value="overlap" selected');
  assertStringIncludes(output, 'value="overlap_asr_corrected"');
  assertStringIncludes(output, "korekce přepisu");
});

Deno.test("promluva nabízí ruční změnu mluvčího i návrat k hlasové kartě", () => {
  const output = transcriptLine({
    id: "100065d7-a95c-45f8-872c-bb16fd455c9f",
    startSeconds: 10,
    endSeconds: 20,
    playbackStartSeconds: 7,
    text: "Testovací promluva.",
    personId: "200065d7-a95c-45f8-872c-bb16fd455c9f",
    displayName: "Jana Nováková",
    localLabel: "SPEAKER_01",
    clusterDisplayName: "Původní hlas",
    speakerAssignmentSource: "manual",
  }, [{
    id: "200065d7-a95c-45f8-872c-bb16fd455c9f",
    displayName: "Jana Nováková",
  }]);
  assertStringIncludes(output, "Ručně upraveno");
  assertStringIncludes(output, "Podle hlasové karty · Původní hlas");
  assertStringIncludes(
    output,
    'value="200065d7-a95c-45f8-872c-bb16fd455c9f" selected',
  );
  assertStringIncludes(output, 'data-method="PATCH"');
  assertStringIncludes(output, 'data-seek="7"');
  assertStringIncludes(output, "[00:00:07–00:00:20]");
});
