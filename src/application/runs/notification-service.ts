import type { RunNotification } from "../../domain/models/notifications";
import type { WorkflowRunRecord } from "../../domain/models/run";
import { SubscriptionStore } from "../../persistence/subscription-store";

export class NotificationService {
  private readonly seenKeys = new Map<string, Set<string>>();
  private readonly promptedApprovals = new Map<string, Set<string>>();

  constructor(private readonly subscriptions: SubscriptionStore) {}

  evaluate(
    repositoryId: string,
    authenticatedLogin: string,
    runs: readonly WorkflowRunRecord[],
    isInitialHydration: boolean,
    authenticatedUserId?: string,
  ): RunNotification[] {
    const seen = this.seenKeys.get(repositoryId) ?? new Set<string>();
    this.seenKeys.set(repositoryId, seen);

    const emitted: RunNotification[] = [];
    for (const run of runs) {
      if (run.status !== "completed") continue;
      const attempt = run.attemptCount || 1;
      const workflowId = run.workflowId ?? 0;
      const actorLogin = run.actor?.login ?? "";
      const key = `${run.id}:${attempt}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (isInitialHydration) continue;

      const mode = workflowId > 0
        ? this.subscriptions.getWorkflowMode(repositoryId, workflowId)
        : "my_runs_only";
      if (mode === "muted") continue;
      if (mode === "my_runs_only" && !isOriginalActor(run, authenticatedLogin, authenticatedUserId)) continue;

      emitted.push({
        id: key,
        repositoryId,
        workflowId,
        runId: run.id,
        attempt,
        title: run.displayTitle,
        actor: actorLogin,
        ...(run.triggeringActor && run.triggeringActor.login !== actorLogin
          ? { triggeringActor: run.triggeringActor.login }
          : {}),
        conclusion: run.conclusion,
        htmlUrl: run.htmlUrl,
      });
    }

    return emitted;
  }

  /** True once per run attempt and environment when the workflow subscription allows an approval prompt. */
  shouldPromptApproval(
    repositoryId: string,
    authenticatedLogin: string,
    authenticatedUserId: string | undefined,
    run: WorkflowRunRecord,
    environmentId: number,
  ): boolean {
    const workflowId = run.workflowId ?? 0;
    const mode = workflowId > 0
      ? this.subscriptions.getWorkflowMode(repositoryId, workflowId)
      : "my_runs_only";
    if (mode === "muted") return false;
    if (mode === "my_runs_only" && !isOriginalActor(run, authenticatedLogin, authenticatedUserId)) return false;
    const prompted = this.promptedApprovals.get(repositoryId) ?? new Set<string>();
    this.promptedApprovals.set(repositoryId, prompted);
    const key = `${run.id}:${run.attemptCount || 1}:${environmentId}`;
    if (prompted.has(key)) return false;
    prompted.add(key);
    return true;
  }

  clear(repositoryId: string): void {
    this.seenKeys.delete(repositoryId);
    this.promptedApprovals.delete(repositoryId);
  }
}

/** Compares the stable original actor ID when available so reruns by teammates never change ownership. */
export function isOriginalActor(
  run: WorkflowRunRecord,
  authenticatedLogin: string,
  authenticatedUserId: string | undefined,
): boolean {
  if (run.actor?.id !== undefined && authenticatedUserId) {
    return String(run.actor.id) === authenticatedUserId;
  }
  return Boolean(authenticatedLogin) && run.actor?.login === authenticatedLogin;
}
