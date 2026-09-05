import { formatTimestamp } from "../../../packages/shared/time.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]!);
}

export function formatByteSize(value: unknown): string {
  let size = Number(value);
  if (!Number.isFinite(size) || size < 0) size = 0;
  const units = ["B", "kB", "MB", "GB", "TB"] as const;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat("cs-CZ", {
    maximumFractionDigits: unit === 0 ? 0 : size >= 10 ? 1 : 2,
  }).format(size);
  return `${formatted} ${units[unit]}`;
}

export function storageUsageHtml(row: Record<string, unknown>): string {
  const total = formatByteSize(row.storageByteSize);
  const details = [
    `Audio: ${formatByteSize(row.storageAudioByteSize)}`,
    `Přepisy: ${formatByteSize(row.storageTranscriptByteSize)}`,
    `Ostatní: ${formatByteSize(row.storageOtherByteSize)}`,
  ].join(" · ");
  return `<strong class="storage-size" tabindex="0" data-tooltip="${escapeHtml(details)}"
    aria-label="Celkem ${escapeHtml(total)}. ${escapeHtml(details)}">${escapeHtml(total)}</strong>`;
}

export function podcastSettingsLink(podcastId: unknown): string {
  return `<a class="button secondary podcast-settings-link"
    href="/podcasts/${escapeHtml(podcastId)}/settings">
    <span class="podcast-settings-cog" aria-hidden="true">⚙</span>
    <span>Nastavení</span>
  </a>`;
}

function settingsToggle(
  endpoint: string,
  label: string,
  description: string,
  checked: boolean,
): string {
  return `<form class="settings-toggle-form" data-api="${escapeHtml(endpoint)}"
    data-method="PATCH" data-toggle-form>
    <label class="toggle-field">
      <span class="toggle-copy"><strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(description)}</small></span>
      <input class="toggle-input" type="checkbox" name="enabled" role="switch"
        aria-label="${escapeHtml(label)}" data-toggle-input${checked ? " checked" : ""}>
      <span class="toggle-track" aria-hidden="true"><span></span></span>
    </label>
  </form>`;
}

export function podcastSettingsBody(podcast: Record<string, unknown>): string {
  const podcastId = escapeHtml(podcast.id);
  const podcastName = escapeHtml(podcast.name);
  const downloadableEpisodeCount = Number(podcast.downloadableEpisodeCount) || 0;
  const prefetchActiveCount = Number(podcast.prefetchActiveCount) || 0;
  const automationEnabled = Boolean(podcast.autoProcessEnabled);
  const autoRefreshEnabled = Boolean(podcast.autoRefreshEnabled);
  const lastImportedAt = podcast.lastImportedAt
    ? new Date(String(podcast.lastImportedAt)).toLocaleString("cs")
    : "nikdy";
  return `<a class="back-link" href="/podcasts/${podcastId}">← Zpět na detail podcastu</a>
    <section class="page-header settings-header"><p class="eyebrow">Nastavení podcastu</p>
      <h1>${podcastName}</h1>
      <p>Správa zdroje, stahování a způsobu zpracování nových epizod.</p>
    </section>
    <section class="settings-grid" aria-label="Nastavení podcastu">
      <article class="card settings-card">
        <div class="settings-card-heading"><div><p class="eyebrow">Zdroj</p>
          <h2>RSS feed</h2></div></div>
        <p>Načte nové epizody, aktualizuje existující metadata a označí díly odstraněné z feedu.</p>
        <p class="settings-value">${escapeHtml(podcast.rssUrl)}</p>
        <p class="meta">Poslední aktualizace: ${escapeHtml(lastImportedAt)}</p>
        ${
    settingsToggle(
      `/api/podcasts/${podcastId}/auto-refresh`,
      "Automatická denní aktualizace",
      "RSS feed se zkontroluje nejvýše jednou za 24 hodin.",
      autoRefreshEnabled,
    )
  }
        <div class="settings-actions"><button data-action="/api/podcasts/${podcastId}/import"
          data-loading-label="Aktualizuji…">Aktualizovat RSS</button></div>
      </article>
      <article class="card settings-card">
        <div class="settings-card-heading"><div><p class="eyebrow">Audio</p>
          <h2>Stažení epizod</h2></div>
          <span class="settings-count">${downloadableEpisodeCount}</span></div>
        <p>Zařadí chybějící dostupná audia do fronty. Přepis a další zpracování se spustí později
          podle nastavení automatizace.</p>
        ${
    prefetchActiveCount > 0
      ? `<div class="alert alert-info"><strong>Probíhá stahování.</strong>
            Ve frontě nebo právě stahovaných je ${prefetchActiveCount} epizod.</div>`
      : '<p class="meta">Aktivní hromadné stahování právě neprobíhá.</p>'
  }
        ${
    settingsToggle(
      `/api/podcasts/${podcastId}/auto-download`,
      "Automatické stahování nových dílů",
      "Při aktualizaci RSS stáhne pouze nově nalezené díly. Pro pravidelnou kontrolu zapněte také automatickou denní aktualizaci. Přepis řídí automatické zpracování.",
      Boolean(podcast.autoDownloadEnabled),
    )
  }
        <div class="settings-actions"><button class="secondary"
          data-action="/api/podcasts/${podcastId}/download-missing"
          data-loading-label="Zařazuji stahování…"
          data-confirm="Do fronty se zařadí pouze stažení audia pro ${downloadableEpisodeCount} epizod. Přepis a další zpracování proběhnou později podle automatiky."
          data-confirm-label="Zařadit stahování"${
    downloadableEpisodeCount > 0 ? "" : " disabled"
  }>Stáhnout chybějící díly (${downloadableEpisodeCount})</button></div>
      </article>
      <article class="card settings-card">
        <div class="settings-card-heading"><div><p class="eyebrow">Zpracování</p>
          <h2>Automatizace</h2></div></div>
        <p>Jakmile je fronta volná, automatika postupně zařazuje nejnovější nezpracované epizody.</p>
        ${
    settingsToggle(
      `/api/podcasts/${podcastId}/auto-processing`,
      "Automatické zpracování epizod",
      "Nové a rozpracované epizody se postupně stáhnou, přepíšou a zaindexují.",
      automationEnabled,
    )
  }
        <div class="automation-status-panel" data-automation-status
          data-endpoint="/api/podcasts/${podcastId}/automation-status" aria-live="polite">
          <p class="meta" data-automation-status-content>Načítám statistiky podcastu…</p>
        </div>
      </article>
      <article class="card settings-card">
        <div class="settings-card-heading"><div><p class="eyebrow">Přepis</p>
          <h2>Diarizace</h2></div></div>
        <p>Určuje, jak se při příštím kompletním zpracování zarovná přepis s rozpoznanými hlasy.</p>
        <form class="settings-form" data-api="/api/podcasts/${podcastId}/transcript-alignment"
          data-method="PATCH">
          <label class="form-field"><span>Zarovnání přepisu a hlasů</span>
            <select name="mode">
              <option value="segment"${
    podcast.transcriptAlignmentMode === "segment" ? " selected" : ""
  }>Původní segmenty – stabilní časy</option>
              <option value="overlap"${
    podcast.transcriptAlignmentMode === "overlap" ? " selected" : ""
  }>Překryvová konverzace – jemnější hlasy</option>
              <option value="overlap_asr_corrected"${
    podcast.transcriptAlignmentMode === "overlap_asr_corrected" ? " selected" : ""
  }>Překryvová diarizace + korekce přepisu</option>
            </select></label>
          <p class="meta">Překryvový režim zachová původní Whisper čas pro přehrávání a citace.
            Varianta s korekcí navíc kontextově ověřuje názvy, anglicismy a odborné termíny;
            trvá déle a provádí další modelové inference.</p>
          <div class="settings-actions"><button class="secondary" type="submit">
            Uložit diarizaci</button></div>
        </form>
      </article>
    </section>`;
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Podcast Intelligence</title>
  <link rel="stylesheet" href="/static/app.css?v=20260831.3">
</head>
<body>
  <header class="site-header"><div class="nav-shell">
    <a href="/" class="brand"><span class="brand-mark">PI</span><span>Podcast Intelligence</span></a>
    <nav><a href="/">Podcasty</a><a href="/search">Vyhledávání</a><a href="/jobs">Úlohy</a>
      <a href="/system-incidents">Upozornění</a></nav>
  </div>
  </header>
  <main class="page-shell">${body}</main>
  <footer><div class="nav-shell">Podcast Intelligence · lokální zpracování podcastů</div></footer>
  <dialog id="confirmation-dialog" class="confirmation-dialog" aria-labelledby="confirmation-title">
    <form method="dialog"><h2 id="confirmation-title">Potvrdit akci</h2>
      <p data-confirmation-message></p>
      <div class="dialog-actions"><button class="secondary" value="cancel">Zrušit</button>
        <button value="confirm" data-confirmation-submit>Pokračovat</button></div>
    </form>
  </dialog>
  <script type="module" src="/static/app.js?v=20260831.3"></script>
</body>
</html>`;
}

export function transcriptLine(
  row: Record<string, unknown>,
  people: Record<string, unknown>[] = [],
): string {
  const start = Number(row.startSeconds);
  const end = Number(row.endSeconds);
  const playbackStart = Number(row.playbackStartSeconds ?? start);
  const manual = row.speakerAssignmentSource === "manual";
  const speaker = manual
    ? row.displayName ?? "Neznámý mluvčí"
    : row.displayName ?? row.localLabel ?? "Neznámý hlas";
  const clusterSpeaker = row.clusterDisplayName ?? row.localLabel ?? "Neznámý hlas";
  const personOptions = people.map((person) =>
    `<option value="${escapeHtml(person.id)}"${
      manual && String(row.personId ?? "") === String(person.id) ? " selected" : ""
    }>${escapeHtml(person.displayName)}</option>`
  ).join("");
  return `<article class="utterance">
    <div class="utterance-heading"><div class="row">
      <button class="timestamp" data-seek="${playbackStart}">[${formatTimestamp(playbackStart)}–${
    formatTimestamp(end)
  }]</button>
      <strong>${escapeHtml(speaker)}</strong>${
    manual ? '<span class="badge badge-info">Ručně upraveno</span>' : ""
  }</div>
      <details class="utterance-speaker-editor"><summary>Změnit mluvčí</summary>
        <form data-api="/api/utterances/${escapeHtml(row.id)}/speaker" data-method="PATCH">
          <label>Mluvčí <select name="speaker" required>
            <option value="cluster"${manual ? "" : " selected"}>Podle hlasové karty · ${
    escapeHtml(clusterSpeaker)
  }</option>
            <option value="unknown"${
    manual && !row.personId ? " selected" : ""
  }>Neznámý mluvčí</option>
            <optgroup label="Osoby">${personOptions}</optgroup>
          </select></label><button class="secondary" type="submit">Uložit</button>
        </form>
      </details></div>
    <p>${escapeHtml(row.text)}</p>
  </article>`;
}
