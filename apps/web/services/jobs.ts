import { formatTimestamp } from "../../../packages/shared/time.ts";
import { escapeHtml } from "./html.ts";

export interface JobDurationView {
  durationMs: number;
  label: "Aktivně" | "Trvalo" | "Dosud aktivně";
  ticking: boolean;
}

export function jobDurationView(
  job: Record<string, unknown>,
  now = new Date(),
): JobDurationView | null {
  const accumulated = Math.max(0, Number(job.processingDurationMs) || 0);
  const status = String(job.status);
  const attempts = Math.max(0, Number(job.attempts) || 0);
  if (status === "queued" && attempts === 0) return null;

  if (status === "running") {
    const activeStartedAt = job.activeStartedAt ? new Date(String(job.activeStartedAt)) : null;
    const activeMs = activeStartedAt && !Number.isNaN(activeStartedAt.getTime())
      ? Math.max(0, now.getTime() - activeStartedAt.getTime())
      : 0;
    return {
      durationMs: accumulated + activeMs,
      label: "Aktivně",
      ticking: activeMs > 0,
    };
  }

  return {
    durationMs: accumulated,
    label: status === "queued" ? "Dosud aktivně" : "Trvalo",
    ticking: false,
  };
}

export function jobDurationHtml(job: Record<string, unknown>, now = new Date()): string {
  const view = jobDurationView(job, now);
  if (!view) return "—";
  const accumulated = Math.max(0, Number(job.processingDurationMs) || 0);
  return `<span data-job-duration data-status="${escapeHtml(job.status)}"
    data-processing-duration-ms="${accumulated}"
    data-active-started-at="${escapeHtml(job.activeStartedAt ?? "")}">${view.label} ${
    formatTimestamp(view.durationMs / 1000)
  }</span>`;
}
