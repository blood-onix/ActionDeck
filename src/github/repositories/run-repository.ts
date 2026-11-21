import type { RepositoryContext } from "../../domain/models/repository";
import { createGitHubClient, loadRepositoryRunPage, loadWorkflowHistory } from "../client/github-client";
import { RepositoryScheduler, type SchedulerLease } from "../rate-limit/repository-scheduler";

export class RunRepository {
  constructor(
    private readonly scheduler: RepositoryScheduler,
    private readonly context: RepositoryContext,
    private readonly token: string,
    private readonly lease?: SchedulerLease,
  ) {}

  loadRecent(signal?: AbortSignal) {
    return this.scheduler.schedule(
      this.context.id,
      "dashboard:repository-runs",
      () => loadRepositoryRunPage(
        createGitHubClient(this.token, (retryAfter) => this.scheduler.defer(this.context.id, retryAfter * 1000)),
        this.context,
        signal,
      ),
      {
        ...(this.lease ? { lease: this.lease } : {}),
        ...(signal ? { signal } : {}),
      },
    );
  }

  loadHistory(workflowId: number, page = 1, signal?: AbortSignal) {
    return this.scheduler.schedule(
      this.context.id,
      `workflow-history:${workflowId}:${page}`,
      () => loadWorkflowHistory(
        createGitHubClient(this.token, (retryAfter) => this.scheduler.defer(this.context.id, retryAfter * 1000)),
        this.context,
        workflowId,
        page,
        signal,
      ),
      {
        ...(this.lease ? { lease: this.lease } : {}),
        ...(signal ? { signal } : {}),
      },
    );
  }
}
