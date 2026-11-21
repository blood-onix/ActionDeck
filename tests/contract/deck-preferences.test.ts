import { describe, expect, it } from "vitest";
import { requestSchema } from "../../src/protocol/envelopes";

const base = { version: 1, type: "request", requestId: "r" } as const;

describe("group and column layout requests", () => {
  it("accepts trimmed group names, null resets, and rejects empty selections", () => {
    const parsed = requestSchema.safeParse({
      ...base,
      operation: "workflow.setGroup",
      payload: { workflowPaths: [".github/workflows/a.yml"], group: "  Infra/Core " },
    });
    expect(parsed.success && parsed.data.payload).toEqual({ workflowPaths: [".github/workflows/a.yml"], group: "Infra/Core" });
    expect(requestSchema.safeParse({
      ...base, operation: "workflow.setGroup", payload: { workflowPaths: [".github/workflows/a.yml"], group: null },
    }).success).toBe(true);
    expect(requestSchema.safeParse({
      ...base, operation: "workflow.setGroup", payload: { workflowPaths: [], group: null },
    }).success).toBe(false);
    expect(requestSchema.safeParse({
      ...base, operation: "workflow.setGroup", payload: { workflowPaths: ["a"], group: "bad\u0007name" },
    }).success).toBe(false);
  });

  it("accepts only known columns with bounded widths", () => {
    const save = (layout: unknown) =>
      requestSchema.safeParse({ ...base, operation: "dashboard.saveColumns", payload: { layout } }).success;
    expect(save({ order: ["path", "lastRun"], hidden: ["actor"], widths: { name: 200, path: 300 } })).toBe(true);
    expect(save({ order: ["bogus"], hidden: [], widths: {} })).toBe(false);
    expect(save({ order: [], hidden: [], widths: { name: 5 } })).toBe(false);
  });
});

describe("open in tab requests", () => {
  const open = (payload: unknown) =>
    requestSchema.safeParse({ ...base, operation: "view.openInTab", payload }).success;

  it("accepts local and dynamic pipelines and positive run ids only", () => {
    expect(open({ kind: "pipeline", workflowPath: ".github/workflows/a.yml" })).toBe(true);
    expect(open({ kind: "pipeline", workflowPath: "dynamic/agents/copilot-pull-request-reviewer" })).toBe(true);
    expect(open({ kind: "run", runId: 123 })).toBe(true);
    expect(open({ kind: "pipeline", workflowPath: "../etc/passwd" })).toBe(false);
    expect(open({ kind: "pipeline", workflowPath: "dynamic/../x" })).toBe(false);
    expect(open({ kind: "run", runId: 0 })).toBe(false);
    expect(open({ kind: "settings" })).toBe(false);
  });
});
