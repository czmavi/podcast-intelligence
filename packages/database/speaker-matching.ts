import type { Sql } from "./client.ts";
import { DomainError, NotFoundError } from "../domain/errors.ts";
import { scoreSpeakerCandidate } from "../domain/speaker-scoring.ts";

const minimumVoiceSimilarity = 0.78;
const minimumCombinedScore = 0.61;
const minimumCandidateMargin = 0.05;

export interface SpeakerMatchCandidate {
  clusterId: string;
  personId: string;
  displayName: string;
  similarities: number[];
  expectedParticipant: boolean;
}

export interface SpeakerMatchSuggestion {
  clusterId: string;
  personId: string;
  displayName: string;
  voiceSimilarity: number;
  confidence: number;
  margin: number;
  referenceCount: number;
}

type SpeakerMatchMode = "suggest" | "assign";

export function selectSpeakerMatchSuggestions(
  candidates: readonly SpeakerMatchCandidate[],
): SpeakerMatchSuggestion[] {
  const byCluster = new Map<string, SpeakerMatchSuggestion[]>();
  for (const candidate of candidates) {
    const score = scoreSpeakerCandidate({
      voiceSimilarities: candidate.similarities,
      expectedParticipant: candidate.expectedParticipant,
      regularHost: true,
      directAddressScore: 0,
    });
    const scored: SpeakerMatchSuggestion = {
      clusterId: candidate.clusterId,
      personId: candidate.personId,
      displayName: candidate.displayName,
      voiceSimilarity: score.voiceSimilarity,
      confidence: score.combinedScore,
      margin: 0,
      referenceCount: score.evidence.referenceCount,
    };
    const clusterCandidates = byCluster.get(candidate.clusterId) ?? [];
    clusterCandidates.push(scored);
    byCluster.set(candidate.clusterId, clusterCandidates);
  }

  const eligible = [...byCluster.values()].flatMap((clusterCandidates) => {
    const ranked = clusterCandidates.sort((a, b) => b.confidence - a.confidence);
    const best = ranked[0];
    if (!best) return [];
    const margin = best.confidence - (ranked[1]?.confidence ?? 0);
    if (
      best.voiceSimilarity < minimumVoiceSimilarity ||
      best.confidence < minimumCombinedScore ||
      margin < minimumCandidateMargin
    ) return [];
    return [{ ...best, margin }];
  }).sort((a, b) => b.confidence - a.confidence);

  const usedPeople = new Set<string>();
  return eligible.filter((suggestion) => {
    if (usedPeople.has(suggestion.personId)) return false;
    usedPeople.add(suggestion.personId);
    return true;
  });
}

interface CandidateRow {
  clusterId: unknown;
  personId: unknown;
  displayName: unknown;
  similarity: unknown;
  expectedParticipant: unknown;
}

async function matchRegularHostsForEpisode(
  sql: Sql,
  episodeId: string,
  mode: SpeakerMatchMode,
): Promise<SpeakerMatchSuggestion[]> {
  return await sql.begin(async (tx) => {
    const episodeRows = await tx`
      SELECT id, podcast_id, active_processing_run_id, transcript_selection_pending
      FROM episodes WHERE id = ${episodeId}
      FOR UPDATE
    `;
    const episode = episodeRows[0];
    if (!episode) throw new NotFoundError("Epizoda");
    if (!episode.activeProcessingRunId || episode.transcriptSelectionPending) {
      throw new DomainError(
        "Epizoda zatím nemá dokončenou diarizaci.",
        "SPEAKERS_NOT_AVAILABLE",
        409,
      );
    }
    const assignmentRows = await tx`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE assigned_person_id IS NOT NULL)::int AS assigned
      FROM speaker_clusters
      WHERE episode_id = ${episodeId}
        AND processing_run_id = ${episode.activeProcessingRunId}
    `;
    const total = Number(assignmentRows[0]?.total ?? 0);
    const assigned = Number(assignmentRows[0]?.assigned ?? 0);
    if (total === 0 && mode === "suggest") {
      throw new DomainError(
        "Epizoda zatím nemá detekované hlasy.",
        "SPEAKERS_NOT_AVAILABLE",
        409,
      );
    }
    if (assigned > 0 && mode === "suggest") {
      throw new DomainError(
        "Automatické návrhy lze spustit jen před prvním přiřazením hlasu.",
        "SPEAKERS_ALREADY_ASSIGNED",
        409,
      );
    }

    const rows = await tx`
      SELECT cluster.id AS cluster_id, person.id AS person_id,
        person.display_name,
        (1 - (candidate.embedding <=> reference.embedding))::float8 AS similarity,
        EXISTS (
          SELECT 1 FROM episode_participants participant
          WHERE participant.episode_id = ${episodeId}
            AND participant.person_id = person.id
        ) AS expected_participant
      FROM speaker_clusters cluster
      JOIN speaker_embeddings candidate ON candidate.speaker_cluster_id = cluster.id
      JOIN podcast_persons association
        ON association.podcast_id = ${episode.podcastId}
        AND association.role = 'moderator'
      JOIN persons person ON person.id = association.person_id
      JOIN speaker_embeddings reference
        ON reference.person_id = person.id
        AND reference.is_verified
        AND reference.model_name = candidate.model_name
      JOIN processing_runs reference_run ON reference_run.id = reference.processing_run_id
      JOIN episodes reference_episode ON reference_episode.id = reference_run.episode_id
      WHERE cluster.episode_id = ${episodeId}
        AND cluster.processing_run_id = ${episode.activeProcessingRunId}
        AND cluster.assigned_person_id IS NULL
        AND cluster.identity_status = 'unknown'
        AND reference_episode.podcast_id = ${episode.podcastId}
        AND NOT EXISTS (
          SELECT 1
          FROM speaker_clusters assigned_cluster
          WHERE assigned_cluster.episode_id = ${episodeId}
            AND assigned_cluster.processing_run_id = ${episode.activeProcessingRunId}
            AND assigned_cluster.assigned_person_id = person.id
        )
    `;
    if (rows.length === 0) {
      if (mode === "assign") return [];
      throw new DomainError(
        "Pro stálé moderátory tohoto podcastu zatím nejsou ověřené hlasové reference.",
        "VOICE_REFERENCES_NOT_AVAILABLE",
        409,
      );
    }

    const candidates = new Map<string, SpeakerMatchCandidate>();
    for (const rawRow of rows) {
      const row = rawRow as unknown as CandidateRow;
      const clusterId = String(row.clusterId);
      const personId = String(row.personId);
      const key = `${clusterId}:${personId}`;
      const candidate = candidates.get(key) ?? {
        clusterId,
        personId,
        displayName: String(row.displayName),
        similarities: [],
        expectedParticipant: Boolean(row.expectedParticipant),
      };
      candidate.similarities.push(Number(row.similarity));
      candidates.set(key, candidate);
    }
    const suggestions = selectSpeakerMatchSuggestions([...candidates.values()]);
    if (suggestions.length === 0) {
      if (mode === "assign") return [];
      throw new DomainError(
        "Nenašel jsem dostatečně jistou shodu se stálými moderátory.",
        "VOICE_MATCH_NOT_CONFIDENT",
        409,
      );
    }
    const assignedSuggestions: SpeakerMatchSuggestion[] = [];
    for (const suggestion of suggestions) {
      if (mode === "suggest") {
        await tx`
          UPDATE speaker_clusters
          SET assigned_person_id = ${suggestion.personId}, identity_status = 'suggested',
            identity_confidence = ${suggestion.confidence},
            identity_source = 'automatic_voice_match', updated_at = now()
          WHERE id = ${suggestion.clusterId} AND assigned_person_id IS NULL
        `;
        continue;
      }
      const assignedRows = await tx`
        UPDATE speaker_clusters
        SET assigned_person_id = ${suggestion.personId}, identity_status = 'verified',
          identity_confidence = ${suggestion.confidence},
          identity_source = 'automatic_voice_match', updated_at = now()
        WHERE id = ${suggestion.clusterId}
          AND assigned_person_id IS NULL
          AND identity_status = 'unknown'
        RETURNING id
      `;
      if (!assignedRows[0]) continue;
      assignedSuggestions.push(suggestion);
      await tx`
        UPDATE utterances
        SET person_id = ${suggestion.personId}
        WHERE speaker_cluster_id = ${suggestion.clusterId}
          AND speaker_assignment_source = 'cluster'
      `;
      await tx`
        INSERT INTO episode_participants (episode_id, person_id, role, source, confidence)
        VALUES (${episodeId}, ${suggestion.personId}, 'moderator', 'voice_match',
          ${suggestion.confidence})
        ON CONFLICT (episode_id, person_id)
        DO UPDATE SET role = 'moderator', source = 'voice_match',
          confidence = EXCLUDED.confidence
        WHERE episode_participants.source <> 'manual'
      `;
    }
    return mode === "assign" ? assignedSuggestions : suggestions;
  });
}

export function suggestRegularHostsForEpisode(
  sql: Sql,
  episodeId: string,
): Promise<SpeakerMatchSuggestion[]> {
  return matchRegularHostsForEpisode(sql, episodeId, "suggest");
}

export function automaticallyAssignRegularHostsForEpisode(
  sql: Sql,
  episodeId: string,
): Promise<SpeakerMatchSuggestion[]> {
  return matchRegularHostsForEpisode(sql, episodeId, "assign");
}
