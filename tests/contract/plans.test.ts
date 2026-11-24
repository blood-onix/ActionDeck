import { describe, expect, it } from "vitest";
import { planControlPayload, planSavePayload } from "../../src/protocol/plans";
import { resolveStatusBarState } from "../../src/application/plans/plan-summary";
import type { ReleasePlan } from "../../src/domain/models/release-plan";

function makePlan(overrides: Partial<ReleasePlan>): ReleasePlan {
  return {
    id: "plan-1",
    name: "Prod Release",
    repositoryId: "repo-1",
    state: "draft",
    currentStepIndex: 0,
    updatedAt: 1,
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
    ...overrides,
  };
}

describe("Release plan protocol contracts", () => {
  it("validates plan save and lifecycle control payloads", () => {
    expect(planSavePayload.safeParse({
      id: "plan-1",
      name: "Production Release",
      steps: [
        {
          id: "step-1",
          workflowId: 1,
          workflowPath: ".github/workflows/build.yml",
          ref: "main",
          inputs: { env: "staging" },
          sensitiveInputKeys: ["deploy_token"],
          gate: "stop_on_non_success",
        },
      ],
    }).success).toBe(true);

    expect(planSavePayload.safeParse({
      id: "plan-1",
      name: "",
      steps: [],
    }).success).toBe(false);

    expect(planControlPayload.safeParse({ planId: "plan-1" }).success).toBe(true);
    expect(planControlPayload.safeParse({ planId: "" }).success).toBe(false);
  });

  it("enforces blocked > countdown > plan > idle precedence for StatusBarState", () => {
    const now = 1_000_000;
    const blocked = makePlan({ state: "blocked_uncertain", blockedReason: "approval" });
    const scheduled = makePlan({
      id: "plan-2",
      state: "scheduled",
      schedule: { kind: "relative", runAtMs: now + 90_000, delayMs: 90_000, timeZone: "UTC" },
    });
    const running = makePlan({ id: "plan-3", state: "running", currentStepIndex: 0 });

    const s1 = resolveStatusBarState([{ plans: [blocked, scheduled, running], pendingApprovals: 2 }], now);
    expect(s1.kind).toBe("blocked");
    expect(s1.warningBackground).toBe(true);
    expect(s1.text).toBe("$(warning) Release blocked: approval");

    const s2 = resolveStatusBarState([{ plans: [scheduled, running], pendingApprovals: 1 }], now);
    expect(s2.kind).toBe("countdown");
    expect(s2.warningBackground).toBe(false);
    expect(s2.text).toBe("$(watch) Release in 01:30");

    const s3 = resolveStatusBarState([{ plans: [running], pendingApprovals: 1 }], now);
    expect(s3.kind).toBe("plan");
    expect(s3.warningBackground).toBe(false);
    expect(s3.text).toContain("$(sync~spin) Prod Release 1/2");

    const s4 = resolveStatusBarState([{ plans: [], pendingApprovals: 3 }], now);
    expect(s4.kind).toBe("idle");
    expect(s4.warningBackground).toBe(false);
    expect(s4.text).toBe("$(layers) 3");
  });
});

describe("dashboard plan projection", () => {
  it("accepts plans whose steps opted into auto-approval", async () => {
    const { dashboardPlanSchema } = await import("../../src/protocol/dashboard");
    const plan = {
      id: "plan-1", name: "Release", repositoryId: "repo-1", state: "draft", currentStepIndex: 0, updatedAt: 1,
      steps: [
        {
          id: "step-1", workflowId: 1, workflowPath: ".github/workflows/infra-network.yml", ref: "main",
          inputs: { environment: "qa" }, sensitiveInputKeys: [], gate: "on_success", state: "pending",
          autoApprove: { environments: ["qa"] },
        },
        {
          id: "step-2", workflowId: 2, workflowPath: ".github/workflows/infra-storage.yml", ref: "main",
          inputs: {}, sensitiveInputKeys: [], gate: "on_success", state: "pending",
          autoApprove: { environments: null },
        },
      ],
    };
    expect(dashboardPlanSchema.safeParse(plan).success).toBe(true);
  });
});
