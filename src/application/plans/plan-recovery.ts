import type { ReleasePlan, ReleasePlanStep } from "../../domain/models/release-plan";
import { evaluatePlanTransition } from "../../domain/services/plan-transitions";
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

export async function recoverInterruptedPlans(
  store: PlanStore,
  repositoryId: string,
  reconciler: StepReconciler,
): Promise<ReleasePlan[]> {
  const plans = store.list(repositoryId);
  const recovered: ReleasePlan[] = [];

  for (const plan of plans) {
    const current = plan.steps[plan.currentStepIndex];
    if (
      (plan.state === "running" || plan.state === "waiting_approval") &&
      current &&
      (current.state === "dispatching" ||
        current.state === "request_accepted" ||
        current.state === "running" ||
        current.state === "waiting_approval")
    ) {
      const outcome = await reconciler.reconcileStep(plan, current);
      const updatedStep: ReleasePlanStep = outcome.state === "outcome_uncertain"
        ? {
          ...current,
          state: "outcome_uncertain",
          error: outcome.error ?? "Interrupted before run association could be confirmed.",
        }
        : outcome.state === "completed"
          ? {
            ...current,
            state: "completed",
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

      const steps = plan.steps.map((step, index) => (index === plan.currentStepIndex ? updatedStep : step));
      const nextDraft: ReleasePlan = { ...plan, steps };
      const transition = evaluatePlanTransition(nextDraft);
      const saved = await store.save({
        ...nextDraft,
        state: transition.state,
        ...(transition.blockedReason ? { blockedReason: transition.blockedReason } : {}),
      });
      recovered.push(saved);
    } else {
      recovered.push(plan);
    }
  }

  return recovered;
}
