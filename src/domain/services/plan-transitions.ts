import type { PlanGate, PlanState, PlanStepState, ReleasePlan, ReleasePlanStep } from "../models/release-plan";

/** Whether the plan may continue after a step that finished with this conclusion. */
export function canAdvanceAfterStep(
  gate: PlanGate,
  conclusion: string | null,
): "advance" | "stop" {
  if (gate === "on_any_completion") return "advance";
  if (conclusion === "success") return "advance";
  return "stop";
}

/** A run of steps dispatched together. `end` is exclusive. */
export interface PlanStage {
  readonly start: number;
  readonly end: number;
}

/** Splits steps into stages: a step joins the stage before it when it runs in parallel with the previous step. */
export function planStages(steps: readonly { readonly parallelWithPrevious?: boolean | undefined }[]): PlanStage[] {
  const stages: PlanStage[] = [];
  steps.forEach((step, index) => {
    const last = stages[stages.length - 1];
    if (index > 0 && step.parallelWithPrevious && last) {
      stages[stages.length - 1] = { start: last.start, end: index + 1 };
    } else {
      stages.push({ start: index, end: index + 1 });
    }
  });
  return stages;
}

/** The stage that contains the step at `index`. */
export function stageAt(
  steps: readonly { readonly parallelWithPrevious?: boolean | undefined }[],
  index: number,
): PlanStage | undefined {
  return planStages(steps).find((stage) => index >= stage.start && index < stage.end);
}

/** Steps that were dispatched and are not finished yet. */
export const ACTIVE_STEP_STATES: ReadonlySet<PlanStepState> = new Set<PlanStepState>([
  "dispatching",
  "request_accepted",
  "running",
  "waiting_approval",
]);

export type StageOutcome =
  /** At least one step is still dispatching or running. */
  | { readonly kind: "active"; readonly waitingApproval: boolean }
  /** Nothing is running; a step's outcome could not be confirmed. */
  | { readonly kind: "uncertain"; readonly steps: readonly ReleasePlanStep[] }
  /** Nothing is running; a step finished in a way its gate does not accept, or could not be dispatched. */
  | { readonly kind: "failed"; readonly steps: readonly ReleasePlanStep[] }
  /** Nothing is running; a step was stopped. */
  | { readonly kind: "stopped" }
  /** Some steps have not been dispatched yet and nothing is running. */
  | { readonly kind: "pending" }
  /** Every step finished and its gate lets the plan continue. */
  | { readonly kind: "succeeded" };

export function stageOutcome(steps: readonly ReleasePlanStep[], stage: PlanStage): StageOutcome {
  const members = steps.slice(stage.start, stage.end);
  const active = members.filter((step) => ACTIVE_STEP_STATES.has(step.state));
  if (active.length > 0) {
    return { kind: "active", waitingApproval: active.some((step) => step.state === "waiting_approval") };
  }
  const uncertain = members.filter((step) => step.state === "outcome_uncertain");
  if (uncertain.length > 0) return { kind: "uncertain", steps: uncertain };
  const failed = members.filter((step) => step.state === "failed");
  if (failed.length > 0) return { kind: "failed", steps: failed };
  if (members.some((step) => step.state === "stopped")) return { kind: "stopped" };
  if (members.some((step) => step.state === "pending")) return { kind: "pending" };
  return { kind: "succeeded" };
}

function stepName(step: ReleasePlanStep): string {
  return step.workflowPath;
}

export function uncertainReason(steps: readonly ReleasePlanStep[]): string {
  const details = steps.map((step) => `${stepName(step)} (${step.error ?? "not confirmed"})`).join(", ");
  return `Outcome is uncertain for ${details}. Check GitHub before retrying, so nothing runs twice.`;
}

export function failedReason(steps: readonly ReleasePlanStep[]): string {
  const details = steps
    .map((step) => `${stepName(step)} (${step.error ?? step.conclusion ?? "non-success"})`)
    .join(", ");
  return steps.length === 1 ? `Stopped at step ${details}.` : `Stopped at steps ${details}.`;
}

/**
 * The plan state that follows from its current stage, without dispatching anything. Used after a reload,
 * when step outcomes were reconciled with GitHub.
 */
export function evaluatePlanTransition(plan: ReleasePlan): {
  readonly state: PlanState;
  readonly blockedReason?: string;
} {
  const stage = stageAt(plan.steps, plan.currentStepIndex);
  if (!stage) return { state: "completed" };
  const outcome = stageOutcome(plan.steps, stage);
  switch (outcome.kind) {
    case "active":
      return { state: outcome.waitingApproval ? "waiting_approval" : "running" };
    case "uncertain":
      return { state: "blocked_uncertain", blockedReason: uncertainReason(outcome.steps) };
    case "failed":
      return { state: "stopped", blockedReason: failedReason(outcome.steps) };
    case "stopped":
      return { state: "stopped" };
    default:
      return { state: plan.state };
  }
}

/**
 * Why a plan's steps cannot be saved, if they cannot. Two runs of the same workflow on the same ref in one
 * stage would be dispatched seconds apart, and GitHub gives no way to tell which run came from which.
 */
export function planStageError(
  steps: ReadonlyArray<{ workflowId: number; workflowPath: string; ref: string; parallelWithPrevious?: boolean | undefined }>,
): string | undefined {
  for (const stage of planStages(steps)) {
    const seen = new Set<string>();
    for (const step of steps.slice(stage.start, stage.end)) {
      const key = `${step.workflowId}\u0000${step.ref}`;
      if (seen.has(key)) {
        return `${step.workflowPath} on ${step.ref} appears twice in steps that start together. Run the second one in a later step.`;
      }
      seen.add(key);
    }
  }
  return undefined;
}

export function isSensitiveInputName(name: string): boolean {
  return /(secret|token|password|key)/i.test(name);
}

export function collectSensitiveKeys(
  inputs: Readonly<Record<string, string>>,
  userMarkedKeys: readonly string[],
): string[] {
  const keys = new Set<string>(userMarkedKeys);
  for (const name of Object.keys(inputs)) {
    if (isSensitiveInputName(name)) keys.add(name);
  }
  return [...keys];
}
