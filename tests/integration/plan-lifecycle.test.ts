import * as assert from "node:assert";
import { PlanStore } from "../../src/persistence/plan-store";
import { ReleasePlanService } from "../../src/application/plans/plan-service";
import { recoverInterruptedPlans } from "../../src/application/plans/plan-recovery";
import { LocalPlanScheduler } from "../../src/application/plans/local-scheduler";
import type { DispatchSubmissionRepository } from "../../src/application/dispatch/dispatch-service";
import type { ReleasePlan } from "../../src/domain/models/release-plan";

class MemoryMemento {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

suite("Release plan lifecycle integration", () => {
  test("stops future steps without cancelling running workflows and recovers without duplicate dispatch", async () => {
    const memento = new MemoryMemento();
    const store = new PlanStore(memento);
    const service = new ReleasePlanService(store);
    const context = {
      id: "acme/demo|origin|file:///repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
      authenticatedUserId: "42",
    };

    const plan: ReleasePlan = {
      id: "plan-int-1",
      name: "Integration Release",
      repositoryId: context.id,
      state: "draft",
      currentStepIndex: 0,
      updatedAt: Date.now(),
      steps: [
        {
          id: "s1",
          workflowId: 1,
          workflowPath: ".github/workflows/build.yml",
          ref: "main",
          inputs: {},
          sensitiveInputKeys: [],
          gate: "stop_on_non_success",
          state: "pending",
        },
        {
          id: "s2",
          workflowId: 2,
          workflowPath: ".github/workflows/deploy.yml",
          ref: "main",
          inputs: {},
          sensitiveInputKeys: [],
          gate: "stop_on_non_success",
          state: "pending",
        },
      ],
    };

    await service.savePlan(plan);
    let submitCount = 0;
    const repo: DispatchSubmissionRepository = {
      loadTarget: async (workflowId) => ({
        state: "available",
        workflowId,
        workflowPath: `.github/workflows/${workflowId}.yml`,
        ref: "main",
        defaultBranch: "main",
        inputs: [],
      }),
      submit: async () => {
        submitCount++;
      },
      listAssociationCandidates: async () => ({ runs: [], partial: false }),
    };

    await service.startPlan(repo, context, plan.id);
    assert.strictEqual(submitCount, 1);

    const stopped = await service.stopPlan(context.id, plan.id);
    assert.strictEqual(stopped.state, "stopped");
    assert.strictEqual(stopped.steps[1]?.state, "stopped");

    // Simulate reload with an interrupted dispatching step
    await store.save({
      ...plan,
      state: "running",
      steps: [{ ...plan.steps[0]!, state: "dispatching" }, plan.steps[1]!],
    });
    const recovered = await recoverInterruptedPlans(store, context.id, {
      reconcileStep: async () => ({ state: "outcome_uncertain" }),
    });
    assert.strictEqual(recovered[0]?.state, "blocked_uncertain");
    assert.strictEqual(submitCount, 1);
  });

  test("marks elapsed scheduled plans as missed_schedule after restart/sleep and resumes only on explicit review", async () => {
    const memento = new MemoryMemento();
    const store = new PlanStore(memento);
    const service = new ReleasePlanService(store);
    const context = {
      id: "acme/demo|origin|file:///repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
      authenticatedUserId: "42",
    };

    const nowMs = 1_700_000_000_000;
    const scheduler = new LocalPlanScheduler(store, { now: () => nowMs + 60_000 }, async () => {});

    const scheduledPlan: ReleasePlan = {
      id: "plan-sched-1",
      name: "Scheduled Release",
      repositoryId: context.id,
      state: "scheduled",
      currentStepIndex: 0,
      updatedAt: nowMs,
      schedule: {
        kind: "absolute",
        runAtMs: nowMs + 10_000,
        timeZone: "UTC",
      },
      steps: [
        {
          id: "s1",
          workflowId: 1,
          workflowPath: ".github/workflows/release.yml",
          ref: "main",
          inputs: { deploy_token: "secret-val" },
          sensitiveInputKeys: ["deploy_token"],
          gate: "stop_on_non_success",
          state: "pending",
        },
      ],
    };

    await service.savePlan(scheduledPlan);
    const persisted = store.get(context.id, scheduledPlan.id)!;
    assert.deepStrictEqual(persisted.steps[0]?.reEntryRequiredKeys, ["deploy_token"]);

    const detected = scheduler.scheduleOrDetectMissed(persisted);
    assert.strictEqual(detected.state, "missed_schedule");
    await service.savePlan(detected);

    await assert.rejects(
      () => scheduler.resumeMissedSchedule(context.id, scheduledPlan.id),
      /Sensitive input re-entry is required/,
    );

    const resumed = await scheduler.resumeMissedSchedule(context.id, scheduledPlan.id, {
      s1: { deploy_token: "fresh-secret" },
    });
    assert.strictEqual(resumed.state, "running");
    assert.deepStrictEqual(resumed.steps[0]?.inputs.deploy_token, "");
    assert.deepStrictEqual(resumed.steps[0]?.reEntryRequiredKeys, ["deploy_token"]);
    scheduler.dispose();
  });
});
