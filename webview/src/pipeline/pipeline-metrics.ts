import type { WorkflowRunRecord } from "../../../src/domain/models/run";

const SAMPLE_LIMIT = 20;
const PASSING_CONCLUSIONS = new Set(["success"]);
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

export interface PipelineRunTiming {
  readonly durationMs: number | null;
  readonly queueMs: number | null;
}

export interface PipelineSummary {
  readonly completed: number;
  readonly passRate: number | null;
  readonly medianDurationMs: number | null;
  readonly medianQueueMs: number | null;
  readonly passedOnRetry: number;
  readonly failures: number;
  readonly sampled: number;
}

function elapsedMs(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function pipelineRunTiming(run: WorkflowRunRecord): PipelineRunTiming {
  return {
    durationMs: elapsedMs(run.runStartedAt, run.completedAt),
    queueMs: elapsedMs(run.createdAt, run.runStartedAt),
  };
}

export function median(values: readonly number[]): number | null {
  const ordered = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle] ?? null
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

export function pipelineSummary(runs: readonly WorkflowRunRecord[]): PipelineSummary {
  const sampled = runs
    .filter((run) => run.status.toLowerCase() === "completed" && run.conclusion !== null)
    .slice(0, SAMPLE_LIMIT);
  const passing = sampled.filter((run) => PASSING_CONCLUSIONS.has(run.conclusion ?? "")).length;
  const failures = sampled.filter((run) => FAILING_CONCLUSIONS.has(run.conclusion ?? "")).length;
  const timings = sampled.map(pipelineRunTiming);

  return {
    completed: sampled.length,
    passRate: passing + failures > 0 ? passing / (passing + failures) : null,
    medianDurationMs: median(timings.flatMap(({ durationMs }) => durationMs === null ? [] : [durationMs])),
    medianQueueMs: median(timings.flatMap(({ queueMs }) => queueMs === null ? [] : [queueMs])),
    passedOnRetry: sampled.filter((run) => run.conclusion === "success" && run.attemptCount > 1).length,
    failures,
    sampled: sampled.length,
  };
}

export function timingAvailability(count: number): string {
  return count === 0 ? "Unavailable" : `${count} known`;
}
