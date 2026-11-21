import type { ReleasePlan, ReleasePlanStep } from "../../domain/models/release-plan";
import { AppError } from "../../domain/models/errors";
import type { PlanStore } from "../../persistence/plan-store";

export interface PlanClock {
  now(): number;
}

export class LocalPlanScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: PlanStore,
    private readonly clock: PlanClock,
    private readonly onFire: (planId: string) => Promise<void>,
  ) {}

  scheduleOrDetectMissed(plan: ReleasePlan): ReleasePlan {
    if (plan.state !== "scheduled" || !plan.schedule) return plan;
    const now = this.clock.now();
    if (plan.schedule.runAtMs <= now) {
      this.clearTimer(plan.id);
      return {
        ...plan,
        state: "missed_schedule",
        blockedReason: "Scheduled start time elapsed while ActionDeck was inactive or asleep. Resume or Cancel explicitly.",
        updatedAt: now,
      };
    }

    this.clearTimer(plan.id);
    const delay = Math.max(0, plan.schedule.runAtMs - now);
    const timer = setTimeout(() => {
      this.timers.delete(plan.id);
      void this.onFire(plan.id);
    }, delay);
    this.timers.set(plan.id, timer);
    return plan;
  }

  async resumeMissedSchedule(
    repositoryId: string,
    planId: string,
    updatedInputs?: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): Promise<ReleasePlan> {
    const plan = this.store.get(repositoryId, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    if (plan.state !== "missed_schedule") {
      throw new AppError("stale", "Only a missed-schedule plan can be resumed here.");
    }
    const steps: ReleasePlanStep[] = plan.steps.map((step) => {
      const provided = updatedInputs?.[step.id] ?? {};
      const merged = { ...step.inputs, ...provided };
      const missingSensitive = (step.reEntryRequiredKeys ?? []).filter(
        (key) => !(merged[key] && merged[key].length > 0),
      );
      if (missingSensitive.length > 0) {
        throw new AppError(
          "invalid_input",
          `Sensitive input re-entry is required for step ${step.workflowPath}: ${missingSensitive.join(", ")}.`,
        );
      }
      return {
        ...step,
        inputs: merged,
        reEntryRequiredKeys: [],
      };
    });

    const resumed: ReleasePlan = {
      ...plan,
      state: "running",
      steps,
      updatedAt: this.clock.now(),
    };
    return this.store.save(resumed);
  }

  clearTimer(planId: string): void {
    const existing = this.timers.get(planId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(planId);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
