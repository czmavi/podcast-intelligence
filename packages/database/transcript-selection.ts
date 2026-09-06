import type postgres from "postgres";
import { DomainError, NotFoundError } from "../domain/errors.ts";

export async function requireSelectedTranscript(
  tx: postgres.TransactionSql,
  episodeId: unknown,
  runId: unknown,
): Promise<void> {
  const episode =
    (await tx`SELECT active_processing_run_id, transcript_selection_pending, rag_excluded
    FROM episodes WHERE id = ${String(episodeId)} FOR UPDATE`)[0];
  if (!episode) throw new NotFoundError("Epizoda");
  if (
    episode.transcriptSelectionPending || episode.ragExcluded ||
    !runId || episode.activeProcessingRunId !== runId
  ) {
    throw new DomainError(
      "Nejdříve vyberte tento přepis pro přiřazení hlasů.",
      "TRANSCRIPT_SELECTION_REQUIRED",
      409,
    );
  }
}
