import type { ReleasePlan, ReleasePlanStep } from "../../domain/models/release-plan";
import { AppError } from "../../domain/models/errors";
import type { PlanStore } from "../../persistence/plan-store";

export interface PlanClock {
  now(): number;
}

/** Shown when a stage's wait finished while VS Code was not running; the user continues it explicitly. */
export const MISSED_WAIT_REASON =
  "The wait before this stage finished while ActionDeck was inactive or asleep. Continue when you are ready.";

export class LocalPlanScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly holdTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: PlanStore,
    private readonly clock: PlanClock,
    private readonly onFire: (planId: string) => Promise<void>,
    /** Called when a stage's wait elapses while VS Code is running. */
    private readonly onHoldElapsed: (planId: string) => Promise<void> = async () => undefined,
  ) {}

  /** Arms the timer for a plan waiting before its next stage, or disarms it for any other plan. */
  syncHold(plan: ReleasePlan): void {
    this.clearHold(plan.id);
    if (plan.state !== "on_hold" || plan.hold?.kind !== "wait") return;
    const delay = Math.max(0, plan.hold.untilMs - this.clock.now());
    const timer = setTimeout(() => {
      this.holdTimers.delete(plan.id);
      void this.onHoldElapsed(plan.id);
    }, delay);
    this.holdTimers.set(plan.id, timer);
  }

  /**
   * After a reload: a wait that already elapsed turns into a confirmation, so nothing is dispatched
   * late without the user deciding. A wait still running is re-armed.
   */
  restoreHold(plan: ReleasePlan): ReleasePlan {
    if (plan.state !== "on_hold" || plan.hold?.kind !== "wait") return plan;
    if (plan.hold.untilMs <= this.clock.now()) {
      this.clearHold(plan.id);
      return { ...plan, hold: { kind: "confirm" }, blockedReason: MISSED_WAIT_REASON, updatedAt: this.clock.now() };
    }
    this.syncHold(plan);
    return plan;
  }

  clearHold(planId: string): void {
    const existing = this.holdTimers.get(planId);
    if (existing) {
      clearTimeout(existing);
      this.holdTimers.delete(planId);
    }
  }

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
    this.clearHold(planId);
    const existing = this.timers.get(planId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(planId);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.holdTimers.values()) clearTimeout(timer);
    this.holdTimers.clear();
  }
}
