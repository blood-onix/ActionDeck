import type { ReleasePlanStep } from "../../../src/domain/models/release-plan";
import { planStages } from "../../../src/domain/services/plan-transitions";

/** How a step starts relative to the steps before it, for the line drawn above it in a plan. */
export interface PlanStepConnector {
  /** Starts at the same time as the step above it. */
  readonly startsTogether: boolean;
  /** Whether it needs the previous steps to succeed ("on_success") or only to finish ("on_any"). */
  readonly gate: "on_success" | "on_any";
  /** The previous stage had several steps, so the gate refers to all of them. */
  readonly afterGroup: boolean;
  readonly waitMinutes?: number;
  readonly confirmBefore?: boolean;
}

type ConnectorStep = Pick<ReleasePlanStep, "gate" | "parallelWithPrevious" | "waitBeforeMinutes" | "confirmBefore">;

/**
 * One connector per step. A step's gate decides what happens after it finishes, so the line above a stage
 * describes the gates of the stage before it: it continues on any result only if every step there allows it.
 */
export function planStepConnectors(steps: readonly ConnectorStep[]): PlanStepConnector[] {
  const stages = planStages(steps);
  return steps.map((step, index) => {
    const stageIndex = stages.findIndex((stage) => index >= stage.start && index < stage.end);
    const stage = stages[stageIndex]!;
    if (index > stage.start) return { startsTogether: true, gate: "on_success", afterGroup: false };
    const previous = stages[stageIndex - 1];
    if (!previous) return { startsTogether: false, gate: "on_success", afterGroup: false };
    const before = steps.slice(previous.start, previous.end);
    return {
      startsTogether: false,
      gate: before.every((candidate) => candidate.gate === "on_any_completion") ? "on_any" : "on_success",
      afterGroup: before.length > 1,
      ...(step.waitBeforeMinutes ? { waitMinutes: step.waitBeforeMinutes } : {}),
      ...(step.confirmBefore ? { confirmBefore: true } : {}),
    };
  });
}
