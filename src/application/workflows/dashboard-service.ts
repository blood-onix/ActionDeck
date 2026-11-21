import type { RepositoryContext } from "../../domain/models/repository";
import type { LocalWorkflow, RemoteWorkflow, WorkflowItem } from "../../domain/models/workflow";
import type { WorkflowRunRecord } from "../../domain/models/run";
import type { SubscriptionMode } from "../../domain/models/notifications";
import { runMetrics } from "../../domain/services/run-metrics";

export function buildDashboard(
  context: RepositoryContext,
  local: readonly LocalWorkflow[],
  remote: readonly RemoteWorkflow[],
  runs: readonly WorkflowRunRecord[],
  /**
   * True when only the first page of runs/inventory was fetched (GitHub has more).
   * This is the normal case for active repositories and is NOT a staleness signal:
   * workflows whose latest run falls outside the window are reported as
   * `run_info_not_loaded`, everything else is `synced`.
   */
  _truncated: boolean,
  historyAccess?: "access_restricted" | "auth_or_org_required" | "partial_stale",
  notificationModes: ReadonlyMap<number, SubscriptionMode> = new Map(),
) {
  const localByPath = new Map(local.map((workflow) => [normalize(workflow.path), workflow]));
  const remoteByPath = new Map(remote.map((workflow) => [normalize(workflow.path), workflow]));
  const reusablePaths = new Set(local.filter((workflow) => workflow.reusable).map((workflow) => normalize(workflow.path)));
  const allPaths = new Set([...localByPath.keys(), ...remoteByPath.keys()].filter((path) => !reusablePaths.has(path)));
  const workflows: WorkflowItem[] = [...allPaths].map((path) => {
    const localWorkflow = localByPath.get(path);
    const remoteWorkflow = remoteByPath.get(path);
    const run = remoteWorkflow ? runs.find((candidate) => candidate.workflowId === remoteWorkflow.id) : undefined;
    const history = remoteWorkflow ? runs.filter((candidate) => candidate.workflowId === remoteWorkflow.id) : [];
    const availability = localWorkflow?.diagnostic ? "invalid_yaml"
      : !remoteWorkflow ? "local_only"
      : remoteWorkflow.state !== "active" ? "disabled"
      : historyAccess === "access_restricted" || historyAccess === "auth_or_org_required" ? "access_restricted"
      : historyAccess === "partial_stale" ? "partial_stale"
      : !localWorkflow ? "remote_only"
      : !run ? "run_info_not_loaded"
      : "synced";
    return {
      id: remoteWorkflow ? String(remoteWorkflow.id) : path,
      ...(remoteWorkflow ? { workflowId: remoteWorkflow.id } : {}),
      path: localWorkflow?.path ?? remoteWorkflow?.path ?? path,
      name: localWorkflow?.name ?? remoteWorkflow?.name ?? path,
      state: remoteWorkflow && remoteWorkflow.state !== "active" ? "disabled" : "active",
      availability,
      historyHydration: !remoteWorkflow ? "not_loaded" : historyAccess === "access_restricted" || historyAccess === "auth_or_org_required"
        ? "restricted"
        : historyAccess === "partial_stale" ? "partial" : "not_loaded",
      folder: localWorkflow?.folder ?? "Ungrouped",
      ...(localWorkflow?.diagnostic ? { diagnostic: localWorkflow.diagnostic } : {}),
      ...(remoteWorkflow
        ? { notificationMode: notificationModes.get(remoteWorkflow.id) ?? "my_runs_only" }
        : {}),
      ...latestRunFields(context, run),
      metrics: runMetrics(history),
    };
  });
  const warning = historyAccess === "auth_or_org_required"
    ? { warningKind: "sso" as const, warning: "Authorize this GitHub session for the organization's SSO policy to load run history." }
    : historyAccess === "partial_stale"
    ? { warningKind: "stale" as const, warning: "Run history could not be refreshed; run details may be out of date." }
    : undefined;
  return {
    repository: { owner: context.owner, repo: context.repo, authenticatedUserId: context.authenticatedUserId ?? "" },
    workflows,
    ...(warning ?? {}),
  };
}

/** Row fields derived from a workflow's newest run; shared by full loads and live background patches. */
export function latestRunFields(context: RepositoryContext, run: WorkflowRunRecord | undefined) {
  return {
    ...(run ? { latestRunId: run.id, latestConclusion: run.conclusion, latestRunAt: run.updatedAt } : {}),
    ...(run?.triggeringActor && run.triggeringActor.login !== run.actor?.login
      ? { latestTriggeringActor: run.triggeringActor.login }
      : {}),
    status: run ? `${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}` : "—",
    title: run?.displayTitle ?? "—",
    branch: run?.branch ?? "—",
    actor: run?.actor?.login ?? "—",
    isMyRun: Boolean(run?.actor?.id && String(run.actor.id) === context.authenticatedUserId),
    duration: run?.status === "in_progress"
      ? "In progress"
      : run?.runStartedAt && run.completedAt
      ? formatDuration(Date.parse(run.completedAt) - Date.parse(run.runStartedAt))
      : "Not available",
  };
}

/** Latest-run patches keyed by workflow id, for pushing background poll results into open dashboards. */
export function latestRunPatches(context: RepositoryContext, runs: readonly WorkflowRunRecord[]) {
  const newest = new Map<number, WorkflowRunRecord>();
  for (const run of runs) {
    if (run.workflowId === undefined) continue;
    const current = newest.get(run.workflowId);
    if (!current || run.id > current.id) newest.set(run.workflowId, run);
  }
  return [...newest.entries()].map(([workflowId, run]) => ({ workflowId, ...latestRunFields(context, run) }));
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Not available";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
