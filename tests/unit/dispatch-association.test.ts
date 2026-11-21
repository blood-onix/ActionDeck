import { describe, expect, it } from "vitest";
import { associateDispatchRun, type DispatchAssociationRequest } from "../../src/application/dispatch/run-association";
import type { WorkflowRunRecord } from "../../src/domain/models/run";

const submittedAt = Date.parse("2026-11-14T00:00:00.000Z");
const request: DispatchAssociationRequest = {
  workflowId: 7,
  ref: "refs/heads/release",
  authenticatedUserId: "42",
  submittedAt,
  acceptedAt: submittedAt + 1_000,
};

function run(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 21,
    workflowId: 7,
    attemptCount: 1,
    hydration: "summary",
    displayTitle: "Release",
    status: "queued",
    conclusion: null,
    event: "workflow_dispatch",
    branch: "release",
    headSha: "abc",
    actor: { id: 42, login: "roman" },
    createdAt: new Date(submittedAt).toISOString(),
    updatedAt: new Date(submittedAt).toISOString(),
    htmlUrl: "https://github.com/acme/demo/actions/runs/21",
    ...overrides,
  };
}

describe("dispatch run association", () => {
  it("associates only a unique matching workflow, ref, event, actor, and time-window candidate", () => {
    const expected = run({ createdAt: new Date(submittedAt - 10_000).toISOString() });
    const result = associateDispatchRun([
      expected,
      run({ id: 22, event: "push" }),
      run({ id: 23, actor: { id: 9, login: "other" } }),
      run({ id: 24, workflowId: 8 }),
      run({ id: 25, branch: "main" }),
    ], request);
    expect(result).toEqual({ state: "associated_run_found", run: expected });
  });

  it("includes both stated clock-skew boundaries", () => {
    const earliest = run({ createdAt: new Date(submittedAt - 10_000).toISOString() });
    const latest = run({ id: 22, createdAt: new Date(request.acceptedAt + 120_000).toISOString() });
    expect(associateDispatchRun([earliest], request).state).toBe("associated_run_found");
    expect(associateDispatchRun([latest], request).state).toBe("associated_run_found");
    expect(associateDispatchRun([
      run({ createdAt: new Date(submittedAt - 10_001).toISOString() }),
    ], request).state).toBe("not_observed");
  });

  it("reports competing matching actors as ambiguous instead of guessing the newest run", () => {
    expect(associateDispatchRun([
      run(),
      run({ id: 22, createdAt: new Date(submittedAt + 2_000).toISOString() }),
    ], request)).toEqual({ state: "ambiguous", candidateRunIds: [21, 22] });
  });

  it("does not correlate when actor identity or the dispatch timing window is invalid", () => {
    expect(associateDispatchRun([run()], { ...request, authenticatedUserId: "" }).state).toBe("not_observed");
    expect(associateDispatchRun([run()], { ...request, acceptedAt: submittedAt - 1 }).state).toBe("not_observed");
  });
});
