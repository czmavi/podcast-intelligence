import type { Sql } from "../../../packages/database/client.ts";
import { uuidSchema } from "../../../packages/domain/schemas.ts";
import { formatTimestamp } from "../../../packages/shared/time.ts";
import { escapeHtml, interceptionLayout } from "./html.ts";

function response(title: string, body: string): Response {
  return new Response(interceptionLayout(title, body), {
    headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

export async function interceptionPages(url: URL, sql: Sql): Promise<Response | null> {
  if (url.pathname === "/odposlechy") {
    return response(
      "Nový odposlech",
      `<section class="page-header interception-hero">
      <p class="eyebrow">Nová nahrávka</p><h1>Zpracovat odposlech</h1>
      <p>Nahrajte MP3, nastavte počet hlasů a způsob zpracování.</p></section>
      <form class="card interception-upload" data-interception-upload>
        <label class="form-field"><span>Název odposlechu</span>
          <input name="title" required maxlength="250" placeholder="Např. Schůzka 8. září"></label>
        <label class="form-field"><span>MP3 soubor</span>
          <input name="audio" type="file" accept="audio/mpeg,.mp3" required></label>
        <div class="interception-options"><label class="form-field"><span>Počet mluvčích</span>
          <select name="speakerCount" required>${
        Array.from({ length: 10 }, (_, index) => `<option>${index + 1}</option>`).join("")
      }</select></label>
          <label class="form-field"><span>Způsob zpracování</span><select name="processingMode" required>
            <option value="segment">Rychlý přepis po segmentech</option>
            <option value="overlap" selected>Překryvová diarizace</option>
            <option value="overlap_asr_corrected">Překryvová diarizace + korekce přepisu</option>
          </select></label></div><p class="meta">Data se ukládají pouze do oddělených demo tabulek.</p>
        <button type="submit">Nahrát a zpracovat</button><p class="danger" data-upload-error></p>
      </form>`,
    );
  }
  if (url.pathname === "/odposlechy/historie") {
    const rows = await sql`SELECT * FROM interceptions ORDER BY created_at DESC`;
    const cards = rows.map((row) =>
      `<article class="card episode-card"><div class="row spread">
      <span class="badge badge-neutral">${escapeHtml(row.processingStatus)}</span>
      <span class="meta">${new Date(String(row.createdAt)).toLocaleString("cs")}</span></div>
      <h2><a href="/odposlechy/${row.id}">${escapeHtml(row.title)}</a></h2>
      <p class="meta">${
        escapeHtml(row.originalFilename)
      } · ${row.speakerCount} mluvčích</p></article>`
    ).join("");
    return response(
      "Historie",
      `<section class="page-header"><p class="eyebrow">Archiv</p>
      <h1>Historie odposlechů</h1></section><section class="episode-list">${
        cards ||
        '<p class="muted">Zatím tu není žádný odposlech.</p>'
      }</section>`,
    );
  }
  if (url.pathname === "/odposlechy/osoby") {
    const people = await sql`SELECT person.*, count(reference.id)::int AS voice_count
      FROM interception_persons person LEFT JOIN interception_person_voice_references reference
      ON reference.person_id = person.id GROUP BY person.id ORDER BY person.display_name`;
    const list = people.map((person) =>
      `<article class="card"><h3>
      <a href="/odposlechy/osoby/${person.id}">${escapeHtml(person.displayName)}</a></h3>
      <p>${escapeHtml(person.description ?? "Bez poznámky")}</p>
      <span class="meta">Hlasové ukázky: ${person.voiceCount}</span></article>`
    ).join("");
    return response(
      "Osoby",
      `<section class="page-header"><p class="eyebrow">Adresář</p>
      <h1>Osoby</h1><p>Bez rolí moderátorů a hostů — pouze samostatné osoby.</p></section>
      <form class="card" data-api="/api/odposlechy/osoby"><h2>Přidat osobu</h2>
        <label class="form-field"><span>Jméno</span><input name="displayName" required maxlength="200"></label>
        <label class="form-field"><span>Poznámka</span><textarea name="description" maxlength="4000"></textarea></label>
        <button type="submit">Přidat</button></form><section><h2>Seznam osob</h2>
      <div class="episode-list">${list || '<p class="muted">Žádné osoby.</p>'}</div></section>`,
    );
  }
  const personMatch = url.pathname.match(/^\/odposlechy\/osoby\/([^/]+)$/);
  if (personMatch?.[1]) {
    const id = uuidSchema.parse(personMatch[1]);
    const person = (await sql`SELECT * FROM interception_persons WHERE id = ${id}`)[0];
    if (!person) return null;
    const samples = await sql`SELECT speaker.representative_start_seconds,
      interception.id AS interception_id, interception.title
      FROM interception_person_voice_references reference
      JOIN interception_speakers speaker ON speaker.id = reference.speaker_id
      JOIN interceptions interception ON interception.id = speaker.interception_id
      WHERE reference.person_id = ${id} ORDER BY reference.created_at DESC`;
    return response(
      String(person.displayName),
      `<a class="back-link" href="/odposlechy/osoby">← Osoby</a>
      <section class="page-header"><p class="eyebrow">Osoba</p><h1>${
        escapeHtml(person.displayName)
      }</h1>
      <p>${
        escapeHtml(person.description ?? "Bez poznámky")
      }</p></section><section><h2>Ukázky hlasu</h2>
      ${
        samples.map((sample) =>
          `<article class="card"><h3><a href="/odposlechy/${sample.interceptionId}">
        ${escapeHtml(sample.title)}</a></h3><audio controls preload="metadata"
        src="/api/odposlechy/${sample.interceptionId}/audio"></audio>
        <button class="secondary" data-seek="${
            Number(sample.representativeStartSeconds ?? 0)
          }">▶ Přehrát ukázku</button></article>`
        ).join("") ||
        '<p class="muted">Osoba zatím nemá hlasovou ukázku.</p>'
      }</section>`,
    );
  }
  const match = url.pathname.match(/^\/odposlechy\/([^/]+)$/);
  if (!match?.[1]) return null;
  const id = uuidSchema.parse(match[1]);
  const item = (await sql`SELECT interception.*, job.progress_percent, job.progress_message
    FROM interceptions interception LEFT JOIN LATERAL (SELECT * FROM jobs
      WHERE entity_type = 'interception' AND entity_id = interception.id
      ORDER BY created_at DESC LIMIT 1) job ON true WHERE interception.id = ${id}`)[0];
  if (!item) return null;
  const [speakers, utterances, people] = await Promise.all([
    sql`SELECT speaker.*, person.display_name FROM interception_speakers speaker
      LEFT JOIN interception_persons person ON person.id = speaker.assigned_person_id
      WHERE speaker.interception_id = ${id} ORDER BY speaker.local_label`,
    sql`SELECT utterance.*, speaker.local_label, person.display_name
      FROM interception_utterances utterance JOIN interception_speakers speaker
      ON speaker.id = utterance.speaker_id LEFT JOIN interception_persons person
      ON person.id = speaker.assigned_person_id WHERE utterance.interception_id = ${id}
      ORDER BY utterance.sequence_number`,
    sql`SELECT * FROM interception_persons ORDER BY display_name`,
  ]);
  const options = people.map((person) =>
    `<option value="${person.id}">${escapeHtml(person.displayName)}</option>`
  ).join("");
  const speakerCards = speakers.map((speaker) =>
    `<article class="card speaker"><div class="speaker-summary"><div>
    <h3>${escapeHtml(speaker.localLabel)}</h3><p>${
      Number(speaker.totalSpeechSeconds).toFixed(1)
    } s ·
    ${speaker.segmentCount} segmentů · <strong>${
      escapeHtml(speaker.displayName ?? "nepřiřazený")
    }</strong></p></div></div>
    <button type="button" class="secondary" data-seek="${
      Number(speaker.representativeStartSeconds ?? 0)
    }">▶ Přehrát ukázku</button>
    <div class="interception-assignments"><form data-api="/api/odposlechy/hlasy/${speaker.id}/priradit">
      <label class="form-field"><span>Existující osoba</span><select name="personId" required>
      <option value="">Vyberte…</option>${options}</select></label><button type="submit">Přiřadit</button></form>
      <form data-api="/api/odposlechy/hlasy/${speaker.id}/priradit"><label class="form-field"><span>Nová osoba</span>
      <input name="displayName" required placeholder="Jméno a příjmení"></label>
      <button type="submit" class="secondary">Vytvořit a přiřadit</button></form></div></article>`
  ).join("");
  const processing = !["ready", "failed"].includes(String(item.processingStatus));
  const transcript = utterances.map((row) =>
    `<article class="utterance"><div class="utterance-heading">
    <button class="timestamp" data-seek="${row.playbackStartSeconds}">[${
      formatTimestamp(Number(row.startSeconds))
    }–${formatTimestamp(Number(row.endSeconds))}]</button>
    <strong>${escapeHtml(row.displayName ?? row.localLabel)}</strong></div><p>${
      escapeHtml(row.text)
    }</p></article>`
  ).join("");
  return response(
    String(item.title),
    `<a class="back-link" href="/odposlechy/historie">← Historie</a>
    <section class="page-header"><p class="eyebrow">Odposlech</p><h1>${escapeHtml(item.title)}</h1>
    <p class="meta">${
      escapeHtml(item.originalFilename)
    } · ${item.speakerCount} mluvčích</p></section>
    <audio controls preload="metadata" src="/api/odposlechy/${id}/audio"></audio>
    ${
      processing
        ? `<section class="card progress-card" data-interception-progress="${id}"><h2>Zpracování</h2>
      <progress max="100" value="${Number(item.progressPercent ?? 0)}"></progress>
      <p data-progress-message>${
          escapeHtml(item.progressMessage ?? "Čeká ve frontě…")
        }</p></section>`
        : ""
    }
    ${
      item.processingError
        ? `<div class="alert alert-danger">${escapeHtml(item.processingError)}</div>`
        : ""
    }
    ${
      item.processingStatus === "ready"
        ? `<section><div class="section-heading row spread"><h2>Hlasy</h2>
      <button data-action="/api/odposlechy/${id}/automaticky-priradit">Automaticky přiřadit existující osoby</button>
      </div><div class="speaker-list">${speakerCards}</div></section><section><h2>Přepis</h2>${transcript}</section>`
        : ""
    }`,
  );
}
