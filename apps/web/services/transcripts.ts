import { escapeHtml } from "./html.ts";
import { formatTimestamp } from "../../../packages/shared/time.ts";

export function transcriptLabel(run: Record<string, unknown>): string {
  const provider = run.transcriptionProvider === "elevenlabs"
    ? "ElevenLabs Scribe"
    : "Lokální přepis";
  const mode = run.transcriptAlignmentMode === "overlap_asr_corrected"
    ? "překryvy + korekce"
    : run.transcriptAlignmentMode === "overlap"
    ? "překryvy"
    : "segmenty";
  return `${provider} · ${run.transcriptionModel ?? "neznámý model"}${
    run.transcriptionProvider === "elevenlabs" ? "" : ` · ${mode}`
  }`;
}

export function transcriptSelectionButton(
  episodeId: unknown,
  run: Record<string, unknown>,
  episode: Record<string, unknown>,
): string {
  const selected = run.id === episode.activeProcessingRunId && !episode.transcriptSelectionPending;
  return selected
    ? '<span class="badge badge-success">Vybraný přepis</span>'
    : `<button class="secondary" data-action="/api/episodes/${
      escapeHtml(episodeId)
    }/transcripts/select"
      data-body='${escapeHtml(JSON.stringify({ runId: run.id }))}'
      ${episode.ragExcluded ? "disabled" : ""}>Použít pro přiřazení hlasů</button>`;
}

export function transcriptVariantsSection(
  episode: Record<string, unknown>,
  runs: Record<string, unknown>[],
  scribeEnabled: boolean,
): string {
  const id = escapeHtml(episode.id);
  return `<section class="card transcript-variants"><h2>Varianty přepisu</h2>
    <p>Každý přepis má vlastní rozdělení hlasů. Porovnejte výsledky a vyberte přepis před přiřazením osob.</p>
    ${
    episode.transcriptSelectionPending
      ? '<div class="alert alert-info">Nový přepis je připravený. Nejdříve vyberte variantu pro přiřazení hlasů a vyhledávání.</div>'
      : ""
  }
    <div class="transcript-variant-list">${
    runs.map((run) =>
      `<article class="transcript-variant">
      <h3>${escapeHtml(transcriptLabel(run))}</h3>
      <p class="meta">${escapeHtml(new Date(String(run.startedAt)).toLocaleString("cs"))} · ${
        Number(run.speakerCount)
      } mluvčích · ${Number(run.utteranceCount)} promluv</p>
      <div class="row">${transcriptSelectionButton(episode.id, run, episode)}
      <a href="/episodes/${id}/transcripts?left=${escapeHtml(run.id)}">Zobrazit / porovnat</a></div>
    </article>`
    ).join("") || "<p>Zatím není žádný dokončený přepis.</p>"
  }</div>
    <details><summary>Vytvořit / přegenerovat přepis</summary>
      <form data-api="/api/episodes/${id}/transcripts" class="settings-form">
        <label>Způsob přepisu <select name="provider">
          <option value="local"${
    episode.normalizedAudioPath ? "" : " disabled"
  }>Lokální přepis a diarizace</option>
          <option value="elevenlabs"${
    scribeEnabled ? (episode.normalizedAudioPath ? "" : " selected") : " disabled"
  }>ElevenLabs Scribe a diarizace</option>
        </select></label>
        <label>Režim lokálního přepisu <select name="transcriptAlignmentMode">
          <option value="segment">Původní segmenty</option>
          <option value="overlap">Překryvová diarizace</option>
          <option value="overlap_asr_corrected">Překryvová diarizace + korekce</option>
        </select></label>
        <p class="meta">ElevenLabs používá vlastní diarizaci s automatickým počtem mluvčích. Audio se odešle do ElevenLabs a přepis se účtuje podle vašeho účtu. Hlasy se přiřazují poslechem.</p>
        ${scribeEnabled ? "" : '<p class="meta">ElevenLabs zatím není nakonfigurovaný.</p>'}
        ${episode.originalAudioPath ? "" : '<p class="meta">Nejdříve stáhněte audio epizody.</p>'}
        <button type="submit"${
    episode.ragExcluded || !episode.originalAudioPath ||
      (!episode.normalizedAudioPath && !scribeEnabled)
      ? " disabled"
      : ""
  }>Vytvořit přepis</button>
      </form>
    </details><p class="meta">Průběh a případné chyby přepisu najdete na stránce <a href="/jobs">Úlohy</a>.</p>
  </section>`;
}

export function transcriptComparison(
  left: Record<string, unknown>[],
  right: Record<string, unknown>[],
): string {
  // Align by audio time, not speaker labels or segment numbers: providers split both differently.
  const buckets = new Map<number, [Record<string, unknown>[], Record<string, unknown>[]]>();
  for (const [side, utterances] of [left, right].entries()) {
    for (const utterance of utterances) {
      const time = Math.floor(Number(utterance.startSeconds) / 30) * 30;
      const bucket = buckets.get(time) ?? [[], []];
      bucket[side as 0 | 1].push(utterance);
      buckets.set(time, bucket);
    }
  }
  const cell = (utterances: Record<string, unknown>[]) =>
    utterances.map((utterance) =>
      `<p><button class="timestamp" data-seek="${
        Number(utterance.playbackStartSeconds ?? utterance.startSeconds)
      }">${formatTimestamp(Number(utterance.startSeconds))}</button>
      <strong>${escapeHtml(utterance.localLabel)}</strong> ${escapeHtml(utterance.text)}</p>`
    ).join("") || '<p class="meta">V tomto úseku není začátek promluvy.</p>';
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([time, [a, b]]) => {
    const text = (rows: Record<string, unknown>[]) =>
      rows.map((row) => String(row.text)).join(" ").replace(/\s+/g, " ").trim();
    return `<section class="transcript-comparison-row${
      text(a) === text(b) ? "" : " transcript-different"
    }">
      <h3>${formatTimestamp(time)}–${formatTimestamp(time + 30)}</h3>
      <div class="transcript-comparison-columns"><div>${cell(a)}</div><div>${cell(b)}</div></div>
    </section>`;
  }).join("");
}
