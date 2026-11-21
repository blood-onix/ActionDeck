import { describe, expect, it } from "vitest";
import { copilotReadToolSchemas } from "../../src/protocol/copilot";

describe("Copilot read-tool contracts", () => {
  it("requires explicit repository, workflow, run, attempt, job, and ref evidence identifiers", () => {
    const schema = copilotReadToolSchemas["actiondeck_get_log_excerpt"];
    const request = {
      repositoryId: "acme/demo|origin|file:///repo",
      workflowId: 7,
      runId: 42,
      attempt: 2,
      jobId: 84,
      stepNumber: 3,
      ref: "main",
    };
    expect(schema.safeParse(request).success).toBe(true);
    expect(schema.safeParse({ ...request, runId: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...request, maxLines: 201 }).success).toBe(false);
    expect(schema.safeParse({ ...request, inferredWorkflow: true }).success).toBe(false);
  });

  it("uses strict bounded schemas for every read-only tool", () => {
    expect(Object.keys(copilotReadToolSchemas)).toEqual([
      "actiondeck_list_workflows",
      "actiondeck_inspect_run",
      "actiondeck_get_log_excerpt",
      "actiondeck_get_workflow_revision",
      "actiondeck_inspect_dispatch_inputs",
      "actiondeck_inspect_plan",
      "actiondeck_inspect_pending_actions",
    ]);
    for (const schema of Object.values(copilotReadToolSchemas)) {
      expect(schema.safeParse({ repositoryId: "repo", unexpected: true }).success).toBe(false);
    }
    expect(copilotReadToolSchemas["actiondeck_get_log_excerpt"].safeParse({
      repositoryId: "repo",
      workflowId: 7,
      runId: 42,
      attempt: 1,
      jobId: 84,
      ref: "main",
      maxLines: 201,
    }).success).toBe(false);
  });
});
