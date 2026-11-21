import { describe, expect, it, vi } from "vitest";
import { PlanStore } from "../../src/persistence/plan-store";
import { recoverInterruptedPlans } from "../../src/application/plans/plan-recovery";
import type { ReleasePlan } from "../../src/domain/models/release-plan";
import { InMemoryStateStore } from "../fixtures/fakes";

describe("Plan persistence, sensitive inputs, and crash/reload recovery", () => {
  it("redacts sensitive inputs into re-entry markers on persistence", async () => {
    const memento = new InMemoryStateStore();
    const store = new PlanStore(memento);
    const plan: ReleasePlan = {
      id: "plan-sec",
      name: "Secure Release",
      repositoryId: "acme/demo|origin|file:///repo",
      state: "draft",
      currentStepIndex: 0,
      updatedAt: 1_000,
      steps: [
        {
          id: "s1",
          workflowId: 1,
          workflowPath: ".github/workflows/deploy.yml",
          ref: "main",
          inputs: {
            api_token: "ghp_secret_123",
            custom_flag: "yes",
            manual_secret: "hunter2",
          },
          sensitiveInputKeys: ["manual_secret"],
          gate: "stop_on_non_success",
          state: "pending",
        },
      ],
    };

    await store.save(plan);
    const reloaded = store.get(plan.repositoryId, plan.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.steps[0]?.inputs.custom_flag).toBe("yes");
    expect(reloaded?.steps[0]?.inputs.api_token).toBe("");
    expect(reloaded?.steps[0]?.inputs.manual_secret).toBe("");
    expect(reloaded?.steps[0]?.reEntryRequiredKeys).toContain("api_token");
    expect(reloaded?.steps[0]?.reEntryRequiredKeys).toContain("manual_secret");
  });

  it("reconciles pre-submission checkpoints without automatically re-dispatching", async () => {
    const memento = new InMemoryStateStore();
    const store = new PlanStore(memento);
    const plan: ReleasePlan = {
      id: "plan-crash",
      name: "Interrupted Plan",
      repositoryId: "acme/demo|origin|file:///repo",
      state: "running",
      currentStepIndex: 0,
      updatedAt: 2_000,
      steps: [
        {
          id: "s1",
          workflowId: 1,
          workflowPath: ".github/workflows/build.yml",
          ref: "main",
          inputs: {},
          sensitiveInputKeys: [],
          gate: "stop_on_non_success",
          state: "dispatching",
          submittedAt: 1_900,
        },
      ],
    };
    await store.save(plan);

    const submit = vi.fn();
    const recovered = await recoverInterruptedPlans(store, "acme/demo|origin|file:///repo", {
      reconcileStep: async () => ({ state: "outcome_uncertain" as const }),
    });

    expect(submit).not.toHaveBeenCalled();
    expect(recovered[0]?.state).toBe("blocked_uncertain");
    expect(recovered[0]?.steps[0]?.state).toBe("outcome_uncertain");
  });
});
