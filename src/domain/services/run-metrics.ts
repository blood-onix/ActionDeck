import type { WorkflowRunRecord } from "../models/run";

const passes = new Set(["success"]);
const failures = new Set(["failure", "timed_out", "startup_failure"]);
const ignored = new Set(["cancelled", "skipped", "neutral", "stale"]);

export function runMetrics(runs: readonly WorkflowRunRecord[], limit = 20) {
  const completed = runs
    .filter((run) => run.status === "completed" && run.conclusion !== null)
    .slice(0, limit);
  let passCount = 0;
  let failureCount = 0;
  const durations: number[] = [];
  for (const run of completed) {
    const conclusion = run.conclusion ?? "";
    if (passes.has(conclusion)) passCount++;
    else if (failures.has(conclusion)) failureCount++;
    else if (!ignored.has(conclusion)) continue;
    if (!ignored.has(conclusion) && run.runStartedAt && run.completedAt) {
      const duration = Date.parse(run.completedAt) - Date.parse(run.runStartedAt);
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
    }
  }
  const denominator = passCount + failureCount;
  return {
    passes: passCount,
    failures: failureCount,
    sampleSize: completed.length,
    scope: `last ${completed.length} observed completed runs`,
    passRate: denominator > 0 ? passCount / denominator : null,
    averageDurationMs: durations.length > 0
      ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
      : null,
  };
}
