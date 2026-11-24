/**
 * What happens after a step finishes. `stop_on_non_success` is kept only so plans saved by earlier builds
 * still load; it behaves exactly like `on_success`, and the editor no longer offers it.
 */
export type PlanGate = "on_success" | "on_any_completion" | "stop_on_non_success";

export type PlanState =
  | "draft"
  | "scheduled"
  | "running"
  | "waiting_approval"
  /** Between stages: waiting out a delay or for the user to continue. See `ReleasePlan.hold`. */
  | "on_hold"
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

/** Why an `on_hold` plan is not dispatching its next stage yet. */
export type PlanHold =
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "confirm" };

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
   * Starts together with the step before it, in the same stage. Every step of a stage is dispatched at
   * once, and the next stage starts only after all of them finish. Ignored on the first step.
   */
  readonly parallelWithPrevious?: boolean;
  /** Minutes to wait before this stage starts. Read from a stage's first step; ignored on the first stage. */
  readonly waitBeforeMinutes?: number;
  /** Ask the user to continue before this stage starts. Read from a stage's first step; ignored on the first stage. */
  readonly confirmBefore?: boolean;
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
  /** Index of the first step of the stage the plan is on. */
  readonly currentStepIndex: number;
  readonly schedule?: PlanSchedule;
  /** Set while the plan is `on_hold`. */
  readonly hold?: PlanHold;
  readonly blockedReason?: string;
  readonly updatedAt: number;
}

/** Plans that have not dispatched anything yet, so their steps and schedule can still change. */
export const EDITABLE_PLAN_STATES: ReadonlySet<PlanState> = new Set<PlanState>(["draft", "scheduled", "missed_schedule"]);

/** Longest wait a stage can ask for before it starts: one day. */
export const MAX_WAIT_BEFORE_MINUTES = 24 * 60;
