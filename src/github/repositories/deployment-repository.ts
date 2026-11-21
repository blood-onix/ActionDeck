import type { RepositoryContext } from "../../domain/models/repository";
import type { PendingEnvironment } from "../../domain/models/approval";
import { createGitHubClient } from "../client/github-client";
import { RepositoryScheduler, type SchedulerLease } from "../rate-limit/repository-scheduler";

export class DeploymentRepository {
  constructor(
    private readonly scheduler: RepositoryScheduler,
    private readonly context: RepositoryContext,
    private readonly token: string,
    private readonly lease?: SchedulerLease,
  ) {}

  listPendingDeployments(runId: number, signal?: AbortSignal): Promise<PendingEnvironment[]> {
    return this.scheduler.schedule(
      this.context.id,
      `pending-deployments:${runId}`,
      async () => {
        const client = createGitHubClient(
          this.token,
          (retryAfter) => this.scheduler.defer(this.context.id, retryAfter * 1000),
        );
        const response = await client.request(
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments",
          {
            owner: this.context.owner,
            repo: this.context.repo,
            run_id: runId,
            request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
          },
        );
        const entries = Array.isArray(response.data) ? response.data : [];
        return entries.map((entry: {
          environment?: { id?: number; name?: string };
          current_user_can_approve?: boolean;
          wait_timer?: number;
          reviewers?: Array<{ reviewer?: { login?: string; name?: string | null; slug?: string } }>;
        }) => {
          const requiredReviewers = (entry.reviewers ?? [])
            .map((item) => item.reviewer?.login ?? item.reviewer?.slug ?? item.reviewer?.name)
            .filter((name): name is string => typeof name === "string" && name.length > 0)
            .slice(0, 20);
          const canApprove = Boolean(entry.current_user_can_approve);
          const waitTimer = typeof entry.wait_timer === "number" ? entry.wait_timer : 0;
          const eligible = canApprove && waitTimer === 0;
          return {
            environmentId: entry.environment?.id ?? 0,
            environmentName: entry.environment?.name ?? "unknown",
            eligible,
            currentUserCanApprove: canApprove,
            waitTimerRemainingSeconds: waitTimer,
            ...(requiredReviewers.length > 0 ? { requiredReviewers } : {}),
            ...(!canApprove
              ? { reason: "Authenticated user is not an authorized reviewer for this environment." }
              : waitTimer > 0
                ? { reason: `Wait timer active (${waitTimer}s remaining).` }
                : {}),
          };
        });
      },
      { ...(this.lease ? { lease: this.lease } : {}), ...(signal ? { signal } : {}) },
    );
  }

  async submitReview(
    runId: number,
    environmentId: number,
    state: "approved" | "rejected",
    comment: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = createGitHubClient(
      this.token,
      (retryAfter) => this.scheduler.defer(this.context.id, retryAfter * 1000),
    );
    await client.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments",
      {
        owner: this.context.owner,
        repo: this.context.repo,
        run_id: runId,
        environment_ids: [environmentId],
        state,
        comment,
        request: { retries: 0, ...(signal ? { signal } : {}) },
      },
    );
  }
}
