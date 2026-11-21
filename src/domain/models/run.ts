export interface WorkflowRunRecord {
  readonly id: number;
  readonly workflowId?: number;
  readonly workflowPath?: string;
  readonly attemptCount: number;
  readonly hydration: "summary";
  readonly displayTitle: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly event: string;
  readonly branch: string;
  readonly headSha: string;
  readonly actor?: { readonly id?: number; readonly login: string };
  readonly triggeringActor?: { readonly id?: number; readonly login: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runStartedAt?: string;
  readonly completedAt?: string;
  readonly htmlUrl: string;
}
