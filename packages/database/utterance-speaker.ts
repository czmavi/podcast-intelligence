import type { UpdateUtteranceSpeakerInput } from "../domain/schemas.ts";
import { NotFoundError } from "../domain/errors.ts";
import type { Sql } from "./client.ts";

export interface UtteranceSpeakerUpdateResult {
  utteranceId: string;
  personId: string | null;
  source: "cluster" | "manual";
}

export async function updateUtteranceSpeaker(
  sql: Sql,
  utteranceId: string,
  input: UpdateUtteranceSpeakerInput,
): Promise<UtteranceSpeakerUpdateResult> {
  return await sql.begin(async (tx) => {
    const utterance = (await tx`
      SELECT utterance.id, utterance.episode_id, episode.podcast_id,
        cluster.assigned_person_id
      FROM utterances utterance
      JOIN speaker_clusters cluster ON cluster.id = utterance.speaker_cluster_id
      JOIN episodes episode ON episode.id = utterance.episode_id
      WHERE utterance.id = ${utteranceId}
      FOR UPDATE OF utterance
    `)[0];
    if (!utterance) throw new NotFoundError("Promluva");

    const source = input.speaker === "cluster" ? "cluster" : "manual";
    let personId: string | null = null;
    if (input.speaker === "cluster") {
      personId = utterance.assignedPersonId ? String(utterance.assignedPersonId) : null;
    } else if (input.speaker !== "unknown") {
      const person = (await tx`
        SELECT person.id
        FROM persons person
        JOIN podcast_persons association
          ON association.person_id = person.id
          AND association.podcast_id = ${utterance.podcastId}
        WHERE person.id = ${input.speaker}
      `)[0];
      if (!person) throw new NotFoundError("Osoba");
      personId = String(person.id);
      await tx`
        INSERT INTO episode_participants (episode_id, person_id, role, source, confidence)
        VALUES (${utterance.episodeId}, ${personId}, 'unknown', 'manual', 1)
        ON CONFLICT (episode_id, person_id) DO NOTHING
      `;
    }

    await tx`
      UPDATE utterances
      SET person_id = ${personId}, speaker_assignment_source = ${source}
      WHERE id = ${utteranceId}
    `;
    return { utteranceId, personId, source };
  });
}
