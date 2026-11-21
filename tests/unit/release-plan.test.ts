import { describe, expect, it, vi } from "vitest";
import {
  canAdvanceAfterStep,
  evaluatePlanTransition,
} from "../../src/domain/services/plan-transitions";
import type { ReleasePlan, ReleasePlanStep } from "../../src/domain/models/release-plan";
import { LocalPlanScheduler } from "../../src/application/plans/local-scheduler";
import { InMemoryStateStore } from "../fixtures/fakes";
import { PlanStore } from "../../src/persistence/plan-store";

function makeStep(overrides: Partial<ReleasePlanStep> = {}): ReleasePlanStep {
  return {
    id: "step-1",
    workflowId: 1,
    workflowPath: ".github/workflows/build.yml",
    ref: "main",
    inputs: {},
    sensitiveInputKeys: [],
    gate: "stop_on_non_success",
    state: "pending",
    ...overrides,
  };
}

function makePlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    id: "plan-1",
    name: "Release v1",
    repositoryId: "acme/demo|origin|file:///repo",
    state: "draft",
    steps: [makeStep({ id: "s1", workflowId: 1 }), makeStep({ id: "s2", workflowId: 2 })],
    currentStepIndex: 0,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("Release plan transitions & local scheduling", () => {
  it("enforces gate rules, keeps waiting_approval non-terminal, and blocks on outcome_uncertain", () => {
    expect(canAdvanceAfterStep("on_success", "success")).toBe("advance");
    expect(canAdvanceAfterStep("on_success", "failure")).toBe("stop");
    expect(canAdvanceAfterStep("stop_on_non_success", "cancelled")).toBe("stop");
    expect(canAdvanceAfterStep("on_any_completion", "failure")).toBe("advance");

    const waitingPlan = makePlan({
      state: "running",
      steps: [
        makeStep({ id: "s1", state: "waiting_approval" }),
        makeStep({ id: "s2", state: "pending" }),
      ],
    });
    expect(evaluatePlanTransition(waitingPlan).state).toBe("waiting_approval");

    const uncertainPlan = makePlan({
      state: "running",
      steps: [
        makeStep({ id: "s1", state: "outcome_uncertain" }),
        makeStep({ id: "s2", state: "pending" }),
      ],
    });
    expect(evaluatePlanTransition(uncertainPlan).state).toBe("blocked_uncertain");
  });

  it("detects missed local schedules and requires explicit resume instead of auto-firing", () => {
    const store = new PlanStore(new InMemoryStateStore());
    let now = 100_000;
    const fired: string[] = [];
    const scheduler = new LocalPlanScheduler(store, { now: () => now }, async (planId) => {
      fired.push(planId);
    });

    const pastPlan = makePlan({
      state: "scheduled",
      schedule: { kind: "absolute", runAtMs: 50_000, timeZone: "UTC" },
    });
    const status = scheduler.scheduleOrDetectMissed(pastPlan);
    expect(status.state).toBe("missed_schedule");
    expect(fired).toEqual([]);

    const futurePlan = makePlan({
      id: "plan-2",
      state: "scheduled",
      schedule: { kind: "absolute", runAtMs: 100_500, timeZone: "UTC" },
    });
    vi.useFakeTimers();
    const scheduled = scheduler.scheduleOrDetectMissed(futurePlan);
    expect(scheduled.state).toBe("scheduled");
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(["plan-2"]);
    scheduler.dispose();
    vi.useRealTimers();
  });
});
