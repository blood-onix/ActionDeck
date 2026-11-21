export interface PendingEnvironment {
  readonly environmentId: number;
  readonly environmentName: string;
  readonly eligible: boolean;
  readonly currentUserCanApprove: boolean;
  readonly waitTimerRemainingSeconds: number;
  readonly requiredReviewers?: readonly string[];
  readonly reason?: string;
}

export interface DeploymentReviewItemResult {
  readonly environmentId: number;
  readonly status: "succeeded" | "failed" | "outcome_uncertain";
  readonly error?: string;
}

export interface AutoApprovalRule {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowId: number;
  readonly environmentName: string;
  readonly ref: string;
  readonly authenticatedUserId: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/**
 * A one-run opt-in to auto-approve deployment gates, given when the user dispatches a workflow.
 * Unlike a rule it never matches another run: it binds to the dispatched run, then expires.
 */
export interface RunApprovalGrant {
  readonly id: string;
  readonly repositoryId: string;
  readonly authenticatedUserId: string;
  readonly workflowId: number;
  readonly ref: string;
  /** Environment names covered, or null for every gate this run waits on. */
  readonly environments: readonly string[] | null;
  readonly submittedAt: number;
  readonly acceptedAt: number;
  readonly runId?: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}
