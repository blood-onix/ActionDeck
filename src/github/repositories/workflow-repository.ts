import type { RepositoryContext } from "../../domain/models/repository";
import type { RemoteWorkflow } from "../../domain/models/workflow";
import { createGitHubClient, loadWorkflowInventory } from "../client/github-client";
import { RepositoryScheduler, type SchedulerLease } from "../rate-limit/repository-scheduler";

export class WorkflowRepository {
  constructor(
    private readonly scheduler: RepositoryScheduler,
    private readonly context: RepositoryContext,
    private readonly token: string,
    private readonly lease?: SchedulerLease,
  ) {}

  load(signal?: AbortSignal): Promise<{ workflows: RemoteWorkflow[]; partial: boolean }> {
    return this.scheduler.schedule(
      this.context.id,
      "dashboard:workflow-inventory",
      async () => loadWorkflowInventory(
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
}
