import type { PlanGate, PlanState, ReleasePlan } from "../models/release-plan";

export function canAdvanceAfterStep(
  gate: PlanGate,
  conclusion: string | null,
): "advance" | "stop" {
  if (gate === "on_any_completion") return "advance";
  if (conclusion === "success") return "advance";
  return "stop";
}

export function evaluatePlanTransition(plan: ReleasePlan): {
  readonly state: PlanState;
  readonly blockedReason?: string;
} {
  const current = plan.steps[plan.currentStepIndex];
  if (!current) {
    return { state: "completed" };
  }
  if (current.state === "waiting_approval") {
    return { state: "waiting_approval" };
  }
  if (current.state === "outcome_uncertain") {
    return {
      state: "blocked_uncertain",
      blockedReason: current.error ?? "Step outcome is uncertain and requires reconciliation before continuing.",
    };
  }
  if (current.state === "failed") {
    return {
      state: "stopped",
      blockedReason: current.error ?? "Step did not succeed under gate rules.",
    };
  }
  if (current.state === "stopped") {
    return { state: "stopped" };
  }
  return { state: plan.state };
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
