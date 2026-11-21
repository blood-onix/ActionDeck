export type PlanGate = "on_success" | "on_any_completion" | "stop_on_non_success";

export type PlanState =
  | "draft"
  | "scheduled"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "stopped"
  | "blocked_uncertain"
  | "missed_schedule";

export type PlanStepState =
  | "pending"
  | "dispatching"
  | "request_accepted"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "stopped"
  | "outcome_uncertain";

export interface PlanSchedule {
  readonly kind: "relative" | "absolute";
  readonly runAtMs: number;
  readonly delayMs?: number;
  readonly timeZone: string;
}

export interface ReleasePlanStep {
  readonly id: string;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly sensitiveInputKeys: readonly string[];
  readonly reEntryRequiredKeys?: readonly string[];
  readonly gate: PlanGate;
  /**
   * One-run opt-in to auto-approve this step's deployment gates. `environments: null` covers every gate
   * the step's run waits on.
   */
  readonly autoApprove?: { readonly environments: readonly string[] | null };
  readonly state: PlanStepState;
  readonly runId?: number;
  readonly conclusion?: string | null;
  readonly htmlUrl?: string;
  readonly submittedAt?: number;
  readonly acceptedAt?: number;
  readonly error?: string;
}

export interface ReleasePlan {
  readonly id: string;
  readonly name: string;
  readonly repositoryId: string;
  readonly state: PlanState;
  readonly steps: readonly ReleasePlanStep[];
  readonly currentStepIndex: number;
  readonly schedule?: PlanSchedule;
  readonly blockedReason?: string;
  readonly updatedAt: number;
}
