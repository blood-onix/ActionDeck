import { describe, expect, it } from "vitest";
import { runMetrics } from "../../src/domain/services/run-metrics";
import { makeRun } from "../fixtures/fakes";

describe("run metrics", () => {
  it("counts success and failures while excluding non-result conclusions", () => {
    const metrics = runMetrics([
      makeRun({ id: 1, conclusion: "success" }),
      makeRun({ id: 2, conclusion: "failure", runStartedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" }),
      makeRun({ id: 3, conclusion: "timed_out" }),
      makeRun({ id: 4, conclusion: "cancelled" }),
      makeRun({ id: 5, conclusion: "skipped" }),
    ]);
    expect(metrics).toEqual({
      passes: 1,
      failures: 2,
      sampleSize: 5,
      scope: "last 5 observed completed runs",
      passRate: 1 / 3,
      averageDurationMs: 60_000,
    });
  });

  it("limits the sample and only includes completed runs", () => {
    const metrics = runMetrics([
      ...Array.from({ length: 22 }, (_, index) => makeRun({ id: index + 1 })),
      makeRun({ id: 23, status: "in_progress", conclusion: null }),
    ]);
    expect(metrics.sampleSize).toBe(20);
    expect(metrics.passes).toBe(20);
  });

  it("reports sparse observed samples and classifies startup failures without counting unknown conclusions", () => {
    const metrics = runMetrics([
      makeRun({ id: 1, conclusion: "startup_failure" }),
      makeRun({ id: 2, conclusion: "neutral" }),
      makeRun({ id: 3, conclusion: "action_required" }),
    ]);
    expect(metrics).toMatchObject({
      passes: 0,
      failures: 1,
      sampleSize: 3,
      scope: "last 3 observed completed runs",
      passRate: 0,
      averageDurationMs: null,
    });
  });
});
