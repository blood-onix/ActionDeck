import { describe, expect, it } from "vitest";
import { copilotExecutionToolSchemas, copilotReadToolSchemas } from "../../src/protocol/copilot";

describe("Copilot execution tool contracts", () => {
  it("validates strict guarded execution schemas and excludes auto-approval-rule or raw-API tools", () => {
    const names = Object.keys(copilotExecutionToolSchemas);
    expect(names).toEqual([
      "actiondeck_dispatch_workflow",
      "actiondeck_run_action",
      "actiondeck_review_deployment",
      "actiondeck_start_plan",
    ]);
    expect(names.some((name) => name.includes("rule"))).toBe(false);
    expect(names.some((name) => name.includes("request") || name.includes("api"))).toBe(false);

    expect(copilotExecutionToolSchemas["actiondeck_dispatch_workflow"].safeParse({
      repositoryId: "acme/demo|origin|file:///repo",
      workflowId: 7,
      ref: "main",
      inputs: { env: "staging" },
    }).success).toBe(true);

    expect(copilotExecutionToolSchemas["actiondeck_dispatch_workflow"].safeParse({
      repositoryId: "acme/demo|origin|file:///repo",
      workflowId: 7,
      ref: "main",
      skipConfirmation: true,
    }).success).toBe(false);

    expect(copilotReadToolSchemas["actiondeck_inspect_plan"].safeParse({
      repositoryId: "acme/demo|origin|file:///repo",
      planId: "plan-1",
    }).success).toBe(true);

    expect(copilotReadToolSchemas["actiondeck_inspect_pending_actions"].safeParse({
      repositoryId: "acme/demo|origin|file:///repo",
    }).success).toBe(true);
  });
});
