import type { ReleasePlan, ReleasePlanStep } from "../../domain/models/release-plan";
import { ACTIVE_STEP_STATES, canAdvanceAfterStep, evaluatePlanTransition, stageAt } from "../../domain/services/plan-transitions";
import type { PlanStore } from "../../persistence/plan-store";

export interface StepReconciler {
  reconcileStep(
    plan: ReleasePlan,
    step: ReleasePlanStep,
  ): Promise<
    | { state: "completed"; runId: number; conclusion: string | null; htmlUrl?: string }
    | { state: "running" | "waiting_approval"; runId: number; htmlUrl?: string }
    | { state: "outcome_uncertain"; error?: string }
  >;
}

/**
 * After a reload, checks every step of each running plan's current stage against GitHub. Nothing is
 * dispatched here: a stage that finished successfully moves on with the next background poll.
 */
export async function recoverInterruptedPlans(
  store: PlanStore,
  repositoryId: string,
  reconciler: StepReconciler,
): Promise<ReleasePlan[]> {
  const plans = store.list(repositoryId);
  const recovered: ReleasePlan[] = [];

  for (const plan of plans) {
    const stage = stageAt(plan.steps, plan.currentStepIndex);
    const interrupted = (plan.state === "running" || plan.state === "waiting_approval") && stage !== undefined &&
      plan.steps.slice(stage.start, stage.end).some((step) => ACTIVE_STEP_STATES.has(step.state));
    if (!interrupted || !stage) {
      recovered.push(plan);
      continue;
    }

    const steps: ReleasePlanStep[] = [...plan.steps];
    for (let index = stage.start; index < stage.end; index++) {
      const current = steps[index]!;
      if (!ACTIVE_STEP_STATES.has(current.state)) continue;
      const outcome = await reconciler.reconcileStep(plan, current);
      steps[index] = outcome.state === "outcome_uncertain"
        ? {
          ...current,
          state: "outcome_uncertain",
          error: outcome.error ?? "Interrupted before run association could be confirmed.",
        }
        : outcome.state === "completed"
          ? {
            ...current,
            state: canAdvanceAfterStep(current.gate, outcome.conclusion) === "advance" ? "completed" : "failed",
            runId: outcome.runId,
            conclusion: outcome.conclusion,
            ...(outcome.htmlUrl ? { htmlUrl: outcome.htmlUrl } : {}),
          }
          : {
            ...current,
            state: outcome.state,
            runId: outcome.runId,
            ...(outcome.htmlUrl ? { htmlUrl: outcome.htmlUrl } : {}),
          };
    }

    const nextDraft: ReleasePlan = { ...plan, steps };
    const transition = evaluatePlanTransition(nextDraft);
    const saved = await store.save({
      ...nextDraft,
      state: transition.state,
      ...(transition.blockedReason ? { blockedReason: transition.blockedReason } : {}),
    });
    recovered.push(saved);
  }

  return recovered;
}
