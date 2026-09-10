import type { Sql } from "./client.ts";
import { DomainError, NotFoundError } from "../domain/errors.ts";

export async function scheduleInterception(
  sql: Sql,
  input: {
    id: string;
    title: string;
    filename: string;
    path: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    speakerCount: number;
    processingMode: "segment" | "overlap" | "overlap_asr_corrected";
  },
  maxAttempts: number,
): Promise<{ interceptionId: string; jobId: string }> {
  return await sql.begin(async (tx) => {
    await tx`INSERT INTO interceptions (
      id, title, original_filename, original_audio_path, audio_mime_type,
      audio_byte_size, audio_sha256, speaker_count, processing_mode
    ) VALUES (${input.id}, ${input.title}, ${input.filename}, ${input.path},
      ${input.mimeType}, ${input.byteSize}, ${input.sha256}, ${input.speakerCount},
      ${input.processingMode})`;
    const jobs = await tx`INSERT INTO jobs (type, entity_type, entity_id, payload, max_attempts)
      VALUES ('PROCESS_INTERCEPTION', 'interception', ${input.id}, '{}'::jsonb, ${maxAttempts})
      RETURNING id`;
    return { interceptionId: input.id, jobId: String(jobs[0]?.id) };
  });
}

export async function assignInterceptionSpeaker(
  sql: Sql,
  speakerId: string,
  input: {
    personId?: string | undefined;
    displayName?: string | undefined;
    description?: string | undefined;
  },
): Promise<{ personId: string }> {
  return await sql.begin(async (tx) => {
    const speaker = (await tx`SELECT id, embedding, embedding_model FROM interception_speakers
      WHERE id = ${speakerId} FOR UPDATE`)[0];
    if (!speaker) throw new NotFoundError("Hlas");
    let personId = input.personId;
    if (!personId) {
      if (!input.displayName) throw new DomainError("Vyplňte jméno osoby.", "PERSON_NAME");
      const created = await tx`INSERT INTO interception_persons
        (display_name, normalized_name, description) VALUES (
          ${input.displayName}, ${
        input.displayName.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs").trim()
      },
          ${input.description ?? null}) RETURNING id`;
      personId = String(created[0]?.id);
    } else if (!(await tx`SELECT id FROM interception_persons WHERE id = ${personId}`)[0]) {
      throw new NotFoundError("Osoba");
    }
    await tx`UPDATE interception_speakers SET assigned_person_id = ${personId},
      assignment_source = 'manual', assignment_confidence = 1, updated_at = now()
      WHERE id = ${speakerId}`;
    if (speaker.embedding) {
      await tx`INSERT INTO interception_person_voice_references
        (person_id, speaker_id, embedding, model_name) VALUES
        (${personId}, ${speakerId}, ${speaker.embedding}, ${speaker.embeddingModel ?? "unknown"})
        ON CONFLICT (person_id, speaker_id) DO NOTHING`;
    }
    return { personId };
  });
}

export async function automaticallyAssignInterceptionSpeakers(sql: Sql, id: string) {
  const rows = await sql`
    WITH candidates AS (
      SELECT speaker.id AS speaker_id, reference.person_id,
        1 - (speaker.embedding <=> reference.embedding) AS confidence,
        row_number() OVER (PARTITION BY speaker.id ORDER BY speaker.embedding <=> reference.embedding) AS rank
      FROM interception_speakers speaker
      JOIN interception_person_voice_references reference ON reference.is_verified
      WHERE speaker.interception_id = ${id} AND speaker.embedding IS NOT NULL
        AND speaker.assigned_person_id IS NULL
    )
    UPDATE interception_speakers speaker SET assigned_person_id = candidate.person_id,
      assignment_source = 'automatic', assignment_confidence = candidate.confidence,
      updated_at = now()
    FROM candidates candidate WHERE speaker.id = candidate.speaker_id
      AND candidate.rank = 1 AND candidate.confidence >= 0.78
    RETURNING speaker.id, speaker.assigned_person_id, speaker.assignment_confidence
  `;
  return rows;
}
