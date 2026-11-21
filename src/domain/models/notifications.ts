export type SubscriptionMode = "my_runs_only" | "all_runs" | "muted";

export interface RunNotification {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowId: number;
  readonly runId: number;
  readonly attempt: number;
  readonly title: string;
  readonly actor: string;
  readonly triggeringActor?: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
}
