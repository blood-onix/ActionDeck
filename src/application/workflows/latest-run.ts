import type { WorkflowRunRecord } from "../../domain/models/run";

export interface LatestRunInfo {
  readonly status: string;
  readonly conclusion: string | null;
  readonly updatedAt: string;
}

export function normalizeWorkflowPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
}

/** Newest run per workflow file, keyed by normalized `.github/workflows/*` path. */
export function latestRunsByWorkflowPath(runs: readonly WorkflowRunRecord[]): Map<string, LatestRunInfo> {
  const newest = new Map<string, WorkflowRunRecord>();
  for (const run of runs) {
    if (!run.workflowPath) continue;
    const key = normalizeWorkflowPath(run.workflowPath);
    const current = newest.get(key);
    if (!current || Date.parse(run.createdAt) > Date.parse(current.createdAt)) newest.set(key, run);
  }
  return new Map([...newest].map(([key, run]) => [key, {
    status: run.status,
    conclusion: run.conclusion,
    updatedAt: run.updatedAt,
  }]));
}
