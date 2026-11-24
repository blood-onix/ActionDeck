import { describe, expect, it } from "vitest";
import { PlanStore } from "../../src/persistence/plan-store";
import { AppError } from "../../src/domain/models/errors";
import { ReleasePlanService } from "../../src/application/plans/plan-service";
import { LocalPlanScheduler, MISSED_WAIT_REASON } from "../../src/application/plans/local-scheduler";
import { recoverInterruptedPlans } from "../../src/application/plans/plan-recovery";
import type { DispatchSubmissionRepository } from "../../src/application/dispatch/dispatch-service";
import type { ReleasePlan, ReleasePlanStep } from "../../src/domain/models/release-plan";
import { planStages, stageOutcome } from "../../src/domain/services/plan-transitions";
import { planStepConnectors } from "../../webview/src/utils/plan-connectors";

class MemoryMemento {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

function step(id: string, workflowId: number, extra: Partial<ReleasePlanStep> = {}): ReleasePlanStep {
  return {
    id,
    workflowId,
    workflowPath: `.github/workflows/w${workflowId}.yml`,
    ref: "main",
    inputs: {},
    sensitiveInputKeys: [],
    gate: "on_success",
    state: "pending",
    ...extra,
  };
}

function setup(steps: ReleasePlanStep[], options: { failSubmitFor?: number; now?: () => number } = {}) {
  const store = new PlanStore(new MemoryMemento());
  const service = new ReleasePlanService(store, undefined, { now: options.now ?? (() => 1_000_000) });
  const submitted: number[] = [];
  const repo: DispatchSubmissionRepository = {
    loadTarget: async (workflowId) => ({
      state: "available",
      workflowId,
      workflowPath: `.github/workflows/w${workflowId}.yml`,
      ref: "main",
      defaultBranch: "main",
      inputs: [],
    }),
    submit: async (workflowId) => {
      if (workflowId === options.failSubmitFor) {
        throw new AppError("invalid_input", "Workflow does not have a workflow_dispatch trigger");
      }
      submitted.push(workflowId);
    },
    listAssociationCandidates: async () => ({ runs: [], partial: false }),
  };
  const plan: ReleasePlan = {
    id: "plan-1",
    name: "Release",
    repositoryId: context.id,
    state: "draft",
    currentStepIndex: 0,
    updatedAt: 1,
    steps,
  };
  return { store, service, repo, submitted, plan, get: () => store.get(context.id, "plan-1")! };
}

const finish = (runId: number, stepId: string, conclusion: string | null = "success") =>
  ({ runId, status: "completed", conclusion, stepId });

describe("plan stages", () => {
  it("groups steps that start together and describes the gate above each stage", () => {
    const steps = [
      step("a", 1),
      step("b", 2),
      step("c", 3, { parallelWithPrevious: true, gate: "on_any_completion" }),
      step("d", 4, { waitBeforeMinutes: 15, confirmBefore: true }),
    ];
    expect(planStages(steps)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]);
    const connectors = planStepConnectors(steps);
    expect(connectors[1]).toMatchObject({ startsTogether: false, gate: "on_success", afterGroup: false });
    expect(connectors[2]).toMatchObject({ startsTogether: true });
    // Step b requires success, so the stage after b and c needs every step to pass.
    expect(connectors[3]).toMatchObject({ gate: "on_success", afterGroup: true, waitMinutes: 15, confirmBefore: true });
  });

  it("ignores a parallel flag on the first step", () => {
    expect(planStages([step("a", 1, { parallelWithPrevious: true }), step("b", 2)])).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it("dispatches a parallel stage together and moves on only after every step finishes", async () => {
    const { service, repo, submitted, plan, get } = setup([
      step("a", 1),
      step("b", 2, { parallelWithPrevious: true }),
      step("c", 3),
    ]);
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    expect(submitted).toEqual([1, 2]);
    expect(get().steps.map((s) => s.state)).toEqual(["request_accepted", "request_accepted", "pending"]);

    await service.advanceOnRunObserved(repo, context, "plan-1", finish(11, "a"));
    expect(submitted).toEqual([1, 2]);
    expect(get().state).toBe("running");

    await service.advanceOnRunObserved(repo, context, "plan-1", { runId: 12, status: "waiting", conclusion: null, waitingApproval: true, stepId: "b" });
    expect(get().state).toBe("waiting_approval");

    await service.advanceOnRunObserved(repo, context, "plan-1", finish(12, "b"));
    expect(submitted).toEqual([1, 2, 3]);
    expect(get().currentStepIndex).toBe(2);

    await service.advanceOnRunObserved(repo, context, "plan-1", finish(13, "c"));
    expect(get().state).toBe("completed");
  });

  it("stops after the whole stage finishes when one step fails, and retries only that step", async () => {
    const { service, repo, submitted, plan, get } = setup([
      step("a", 1),
      step("b", 2, { parallelWithPrevious: true }),
      step("c", 3),
    ]);
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(11, "a", "failure"));
    // The other step of the stage is still running, so the plan keeps following it.
    expect(get().state).toBe("running");
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(12, "b"));
    expect(get().state).toBe("stopped");
    expect(get().blockedReason).toContain(".github/workflows/w1.yml");
    expect(submitted).toEqual([1, 2]);

    await service.retryPlan(repo, context, "plan-1");
    expect(submitted).toEqual([1, 2, 1]);
    expect(get().steps.map((s) => s.state)).toEqual(["request_accepted", "completed", "pending"]);
    expect(get().steps[0]?.runId).toBeUndefined();

    await service.advanceOnRunObserved(repo, context, "plan-1", finish(21, "a"));
    expect(submitted).toEqual([1, 2, 1, 3]);
  });

  it("lets a step that continues whatever the result carry the stage through a failure", async () => {
    const { service, repo, submitted, plan, get } = setup([
      step("a", 1, { gate: "on_any_completion" }),
      step("b", 2),
    ]);
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(11, "a", "failure"));
    expect(submitted).toEqual([1, 2]);
    expect(get().steps[0]?.state).toBe("completed");
  });

  it("records a step that could not be dispatched instead of leaving the plan half-started", async () => {
    const { service, repo, submitted, plan, get } = setup(
      [step("a", 1), step("b", 2, { parallelWithPrevious: true })],
      { failSubmitFor: 1 },
    );
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    expect(submitted).toEqual([2]);
    expect(get().steps[0]).toMatchObject({ state: "failed" });
    expect(get().steps[0]?.error).toMatch(/^Not dispatched:/);
    expect(get().state).toBe("running");
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(12, "b"));
    expect(get().state).toBe("stopped");
  });

  it("waits before a stage, then asks for confirmation, then continues", async () => {
    let now = 1_000_000;
    const { service, repo, submitted, plan, get } = setup(
      [step("a", 1), step("b", 2, { waitBeforeMinutes: 10, confirmBefore: true })],
      { now: () => now },
    );
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(11, "a"));
    expect(get()).toMatchObject({ state: "on_hold", currentStepIndex: 1, hold: { kind: "wait", untilMs: now + 600_000 } });
    expect(submitted).toEqual([1]);

    now += 600_000;
    await service.continuePlan(repo, context, "plan-1", "timer");
    expect(get()).toMatchObject({ state: "on_hold", hold: { kind: "confirm" } });
    expect(submitted).toEqual([1]);

    await service.continuePlan(repo, context, "plan-1", "user");
    expect(get().state).toBe("running");
    expect(get().hold).toBeUndefined();
    expect(submitted).toEqual([1, 2]);
  });

  it("skips the rest of a wait when the user starts the stage now", async () => {
    const { service, repo, submitted, plan, get } = setup([step("a", 1), step("b", 2, { waitBeforeMinutes: 30 })]);
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(11, "a"));
    expect(get().state).toBe("on_hold");
    await service.continuePlan(repo, context, "plan-1", "user");
    expect(submitted).toEqual([1, 2]);
  });

  it("resumes a stopped plan from where it stopped", async () => {
    const { service, repo, submitted, plan, get } = setup([step("a", 1), step("b", 2), step("c", 3)]);
    await service.savePlan(plan);
    await service.startPlan(repo, context, "plan-1");
    await service.stopPlan(context.id, "plan-1");
    expect(get().steps.map((s) => s.state)).toEqual(["request_accepted", "stopped", "stopped"]);
    await service.advanceOnRunObserved(repo, context, "plan-1", finish(11, "a"));
    // A stopped plan does not move on by itself, even when its running step finishes.
    expect(submitted).toEqual([1]);

    await service.retryPlan(repo, context, "plan-1");
    expect(get().steps.map((s) => s.state)).toEqual(["request_accepted", "pending", "pending"]);
  });

  it("refuses to retry a plan that is not stopped or blocked", async () => {
    const { service, repo, plan } = setup([step("a", 1)]);
    await service.savePlan(plan);
    await expect(service.retryPlan(repo, context, "plan-1")).rejects.toThrow(/stopped or blocked/);
  });

  it("reports a stage as active, failed, uncertain or succeeded", () => {
    const stage = { start: 0, end: 2 };
    expect(stageOutcome([step("a", 1, { state: "running" }), step("b", 2, { state: "failed" })], stage).kind).toBe("active");
    expect(stageOutcome([step("a", 1, { state: "completed" }), step("b", 2, { state: "failed" })], stage).kind).toBe("failed");
    expect(stageOutcome([step("a", 1, { state: "outcome_uncertain" }), step("b", 2, { state: "failed" })], stage).kind).toBe("uncertain");
    expect(stageOutcome([step("a", 1, { state: "completed" }), step("b", 2, { state: "completed" })], stage).kind).toBe("succeeded");
  });
});

describe("plan stage recovery and holds after a reload", () => {
  it("reconciles every running step of a parallel stage", async () => {
    const store = new PlanStore(new MemoryMemento());
    await store.save({
      id: "plan-1",
      name: "Release",
      repositoryId: context.id,
      state: "running",
      currentStepIndex: 0,
      updatedAt: 1,
      steps: [
        step("a", 1, { state: "running", runId: 11 }),
        step("b", 2, { state: "running", runId: 12, parallelWithPrevious: true }),
        step("c", 3),
      ],
    });
    const [recovered] = await recoverInterruptedPlans(store, context.id, {
      reconcileStep: async (_plan, current) => current.runId === 11
        ? { state: "completed", runId: 11, conclusion: "success" }
        : { state: "waiting_approval", runId: 12 },
    });
    expect(recovered?.steps.map((s) => s.state)).toEqual(["completed", "waiting_approval", "pending"]);
    expect(recovered?.state).toBe("waiting_approval");
  });

  it("turns a wait that elapsed while VS Code was closed into a confirmation", () => {
    const store = new PlanStore(new MemoryMemento());
    const scheduler = new LocalPlanScheduler(store, { now: () => 2_000_000 }, async () => undefined);
    const held: ReleasePlan = {
      id: "plan-1",
      name: "Release",
      repositoryId: context.id,
      state: "on_hold",
      hold: { kind: "wait", untilMs: 1_000_000 },
      currentStepIndex: 1,
      updatedAt: 1,
      steps: [step("a", 1, { state: "completed" }), step("b", 2, { waitBeforeMinutes: 5 })],
    };
    expect(scheduler.restoreHold(held)).toMatchObject({ hold: { kind: "confirm" }, blockedReason: MISSED_WAIT_REASON });
    const future = { ...held, hold: { kind: "wait" as const, untilMs: 3_000_000 } };
    expect(scheduler.restoreHold(future)).toBe(future);
    scheduler.dispose();
  });
});

describe("plan stage validation", () => {
  it("rejects the same workflow and ref twice in steps that start together", async () => {
    const { planStageError } = await import("../../src/domain/services/plan-transitions");
    expect(planStageError([step("a", 1), step("b", 1)])).toBeUndefined();
    expect(planStageError([step("a", 1), step("b", 1, { parallelWithPrevious: true, ref: "release" })])).toBeUndefined();
    expect(planStageError([step("a", 1), step("b", 1, { parallelWithPrevious: true })])).toMatch(/appears twice/);
  });
});
