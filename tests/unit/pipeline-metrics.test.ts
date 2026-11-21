import { describe, expect, it } from "vitest";
import { pipelineRunTiming, pipelineSummary } from "../../webview/src/pipeline/pipeline-metrics";
import { makeRun } from "../fixtures/fakes";

describe("pipeline metrics", () => {
  it("computes medians and retries from summary run data", () => {
    const runs = [
      makeRun({
        id: 1,
        createdAt: "2026-01-01T00:00:00Z",
        runStartedAt: "2026-01-01T00:00:10Z",
        completedAt: "2026-01-01T00:01:10Z",
        attemptCount: 2,
      }),
      makeRun({
        id: 2,
        conclusion: "failure",
        createdAt: "2026-01-01T01:00:00Z",
        runStartedAt: "2026-01-01T01:00:30Z",
        completedAt: "2026-01-01T01:03:30Z",
      }),
      makeRun({
        id: 3,
        conclusion: "success",
        createdAt: "2026-01-01T02:00:00Z",
        runStartedAt: "2026-01-01T02:00:20Z",
        completedAt: "2026-01-01T02:02:20Z",
      }),
    ];

    expect(pipelineSummary(runs)).toEqual({
      completed: 3,
      passRate: 2 / 3,
      medianDurationMs: 120_000,
      medianQueueMs: 20_000,
      passedOnRetry: 1,
      failures: 1,
      sampled: 3,
    });
    expect(pipelineRunTiming(makeRun({ runStartedAt: undefined, completedAt: undefined }))).toEqual({
      durationMs: null,
      queueMs: null,
    });
  });

  it("limits completed-run samples and does not infer missing timing", () => {
    const runs = Array.from({ length: 22 }, (_, index) => makeRun({ id: index + 1 }));
    runs[0] = makeRun({ id: 1, runStartedAt: undefined });
    const summary = pipelineSummary(runs);
    expect(summary.sampled).toBe(20);
    expect(summary.medianDurationMs).toBeNull();
    expect(summary.medianQueueMs).toBeNull();
  });
});
