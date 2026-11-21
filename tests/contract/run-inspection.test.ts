import { describe, expect, it } from "vitest";
import { runActionPayload, runInspectPayload, runLogsPayload } from "../../src/protocol/runs";

describe("run inspection protocol", () => {
  it("requires a concrete run and optional positive attempt number", () => {
    expect(runInspectPayload.safeParse({ runId: 7 }).success).toBe(true);
    expect(runInspectPayload.safeParse({ runId: 7, attempt: 2 }).success).toBe(true);
    expect(runInspectPayload.safeParse({ runId: 0 }).success).toBe(false);
    expect(runInspectPayload.safeParse({ runId: 7, attempt: 0 }).success).toBe(false);
    expect(runInspectPayload.safeParse({ runId: 7, url: "https://example.com" }).success).toBe(false);
  });

  it("binds logs to a run attempt, job, and optional step", () => {
    expect(runLogsPayload.safeParse({ runId: 7, attempt: 2, jobId: 9, stepNumber: 1 }).success).toBe(true);
    expect(runLogsPayload.safeParse({ runId: 7, attempt: 0, jobId: 9 }).success).toBe(false);
    expect(runLogsPayload.safeParse({ runId: 7, attempt: 2, jobId: 0 }).success).toBe(false);
    expect(runLogsPayload.safeParse({ runId: 7, attempt: 2, jobId: 9, stepNumber: 0 }).success).toBe(false);
    expect(runLogsPayload.safeParse({ runId: 7, attempt: 2, jobId: 9, text: "unbounded" }).success).toBe(false);
  });

  it("allows only exact cancel or rerun-failed target identities", () => {
    expect(runActionPayload.safeParse({ action: "cancel", runId: 7, attempt: 2 }).success).toBe(true);
    expect(runActionPayload.safeParse({ action: "rerun_failed_jobs", runId: 7, attempt: 2 }).success).toBe(true);
    expect(runActionPayload.safeParse({ action: "approve", runId: 7, attempt: 2 }).success).toBe(false);
    expect(runActionPayload.safeParse({ action: "cancel", runId: 7, attempt: 2, ref: "main" }).success).toBe(false);
  });
});
