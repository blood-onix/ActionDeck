import { describe, expect, it } from "vitest";
import { PlanStore } from "../../src/persistence/plan-store";
import { ReleasePlanService } from "../../src/application/plans/plan-service";
import type { DispatchSubmissionRepository } from "../../src/application/dispatch/dispatch-service";
import type { ReleasePlan } from "../../src/domain/models/release-plan";

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

function step(id: string, workflowId: number) {
  return {
    id,
    workflowId,
    workflowPath: `.github/workflows/${workflowId}.yml`,
    ref: "main",
    inputs: { deploy_token: "s3cret" },
    sensitiveInputKeys: ["deploy_token"],
    gate: "stop_on_non_success" as const,
    state: "pending" as const,
  };
}

describe("ReleasePlanService transient sensitive inputs", () => {
  it("keeps re-entered secrets in memory across steps, never on disk, and clears them on completion", async () => {
    const memento = new MemoryMemento();
    const store = new PlanStore(memento);
    const service = new ReleasePlanService(store);
    const submitted: Array<Record<string, string>> = [];
    const repo: DispatchSubmissionRepository = {
      loadTarget: async (workflowId) => ({
        state: "available",
        workflowId,
        workflowPath: `.github/workflows/${workflowId}.yml`,
        ref: "main",
        defaultBranch: "main",
        inputs: [{ name: "deploy_token", type: "string", required: true, sourceRef: "main" }],
      }),
      submit: async (_workflowId, _ref, inputs) => {
        submitted.push({ ...inputs });
      },
      listAssociationCandidates: async () => ({ runs: [], partial: false }),
    };
    const plan: ReleasePlan = {
      id: "p1",
      name: "p1",
      repositoryId: context.id,
      state: "draft",
      currentStepIndex: 0,
      updatedAt: Date.now(),
      steps: [step("s1", 1), step("s2", 2)],
    };
    await service.savePlan(plan);
    await service.startPlan(repo, context, "p1", { s1: { deploy_token: "s3cret" }, s2: { deploy_token: "s3cret" } });
    expect(submitted[0]?.deploy_token).toBe("s3cret");
    expect(JSON.stringify(memento.get(`actiondeck.plans.v1:${context.id}`))).not.toContain("s3cret");

    await service.advanceOnRunObserved(repo, context, "p1", { runId: 1, status: "completed", conclusion: "success" });
    expect(submitted[1]?.deploy_token).toBe("s3cret");

    await service.advanceOnRunObserved(repo, context, "p1", { runId: 2, status: "completed", conclusion: "success" });
    expect(store.get(context.id, "p1")?.state).toBe("completed");

    // A fresh service (host reload) has no secret and must pause instead of dispatching blanks.
    const reloaded = new ReleasePlanService(store);
    await store.save({
      ...plan,
      state: "running",
      steps: [{ ...step("s1", 1), state: "completed" }, step("s2", 2)],
      currentStepIndex: 0,
    });
    const paused = await reloaded.advanceOnRunObserved(repo, context, "p1", {
      runId: 1,
      status: "completed",
      conclusion: "success",
    });
    expect(paused.state).toBe("paused");
    expect(paused.blockedReason).toContain("deploy_token");
    expect(submitted).toHaveLength(2);
  });
});
