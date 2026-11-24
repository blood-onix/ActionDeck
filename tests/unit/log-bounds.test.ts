import { describe, expect, it } from "vitest";
import { boundLogExcerpt, locateStepLog, LOG_TRUNCATION_MARKER, MAX_LOG_BYTES, MAX_LOG_LINES } from "../../src/domain/services/log-bounds";

describe("bounded log excerpts", () => {
  it("limits by line count and removes controls and known secret assignments", () => {
    const input = `token=topsecret\u0000\n${Array.from({ length: MAX_LOG_LINES + 20 }, (_, index) => `line ${index}`).join("\n")}`;
    const result = boundLogExcerpt(4, 2, input, "2026-11-14T00:00:00.000Z");
    expect(result.availability).toBe("truncated");
    expect(result.truncated).toBe(true);
    expect(result.text.split("\n")).toHaveLength(MAX_LOG_LINES);
    expect(result.text).not.toContain("topsecret");
    expect(result.text).not.toContain("\u0000");
    expect(result.jobId).toBe(4);
    expect(result.attempt).toBe(2);
  });

  it("limits by UTF-8 bytes before returning an excerpt", () => {
    const result = boundLogExcerpt(1, 1, "é".repeat(MAX_LOG_BYTES));
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(result.truncated).toBe(true);
  });
});

describe("step log boundaries", () => {
  const steps = [
    { number: 1, startedAt: "2026-11-14T10:00:00Z", completedAt: "2026-11-14T10:00:01Z" },
    { number: 2, startedAt: "2026-11-14T10:00:05Z", completedAt: "2026-11-14T10:00:06Z" },
    { number: 3 },
  ];
  const log = [
    "2026-11-14T10:00:00.5000000Z ##[group]Run setup",
    "2026-11-14T10:00:05.2000000Z ##[group]Run build",
    "multi-line continuation without a timestamp",
    "2026-11-14T10:00:06.7000000Z done",
    "2026-11-14T10:00:09.0000000Z later",
  ].join("\n");

  it("returns the lines owned exclusively by the step's reported time window", () => {
    const result = locateStepLog(log, steps, 2);
    expect(result.state).toBe("identified");
    if (result.state === "identified") {
      expect(result.text).toBe([
        "2026-11-14T10:00:05.2000000Z ##[group]Run build",
        "multi-line continuation without a timestamp",
        "2026-11-14T10:00:06.7000000Z done",
      ].join("\n"));
    }
  });

  it("splits steps that share a second at the runner's step marker and ignores skipped steps", () => {
    const jobSteps = [
      { number: 1, conclusion: "success", startedAt: "2026-11-24T13:41:20Z", completedAt: "2026-11-24T13:41:21Z" },
      { number: 2, conclusion: "skipped", startedAt: "2026-11-24T13:41:21Z", completedAt: "2026-11-24T13:41:21Z" },
      { number: 3, conclusion: "success", startedAt: "2026-11-24T13:41:21Z", completedAt: "2026-11-24T13:41:49Z" },
      { number: 4, conclusion: "success", startedAt: "2026-11-24T13:41:49Z", completedAt: "2026-11-24T13:41:51Z" },
      { number: 5, conclusion: "success", startedAt: "2026-11-24T13:41:51Z", completedAt: "2026-11-24T13:41:51Z" },
    ];
    const jobLog = [
      "2026-11-24T13:41:20.1000000Z ##[group]Run ./prepare",
      "2026-11-24T13:41:21.2000000Z prepared",
      "2026-11-24T13:41:21.4000000Z ##[group]Run terraform plan",
      "2026-11-24T13:41:47.0000000Z Plan: 0 to add, 0 to change, 1 to destroy.",
      "2026-11-24T13:41:49.1000000Z Releasing state lock.",
      "2026-11-24T13:41:49.3000000Z Prepare all required actions",
      "2026-11-24T13:41:49.4000000Z ##[group]Run ./.github/actions/summarize-plan",
      "2026-11-24T13:41:50.0000000Z | delete (1) | example-resource |",
      "2026-11-24T13:41:51.1000000Z ##[group]Run rm -f .terraformrc",
      "2026-11-24T13:41:51.2000000Z cleaned",
    ].join("\n");

    const plan = locateStepLog(jobLog, jobSteps, 3);
    expect(plan).toEqual({ state: "identified", text: jobLog.split("\n").slice(2, 5).join("\n") });
    const examine = locateStepLog(jobLog, jobSteps, 4);
    expect(examine).toEqual({ state: "identified", text: jobLog.split("\n").slice(5, 8).join("\n") });
    const cleanup = locateStepLog(jobLog, jobSteps, 5);
    expect(cleanup).toEqual({ state: "identified", text: jobLog.split("\n").slice(8).join("\n") });
    expect(locateStepLog(jobLog, jobSteps, 1)).toEqual({ state: "identified", text: jobLog.split("\n").slice(0, 2).join("\n") });
  });

  it("does not invent boundaries for running, overlapping, untimestamped, or truncated logs", () => {
    expect(locateStepLog(log, steps, 3).state).toBe("unidentified");
    expect(locateStepLog(log, [
      steps[0]!,
      { number: 2, startedAt: "2026-11-14T10:00:01Z", completedAt: "2026-11-14T10:00:06Z" },
    ], 2).state).toBe("unidentified");
    expect(locateStepLog("plain text\nno timestamps", steps, 2).state).toBe("unidentified");
    expect(locateStepLog("2026-11-14T10:00:06Z b\n2026-11-14T10:00:05Z a", steps, 2).state).toBe("unidentified");
    expect(locateStepLog(log, steps, 99).state).toBe("unidentified");
    const truncated = `${LOG_TRUNCATION_MARKER}\n2026-11-14T10:00:05Z a\n2026-11-14T10:00:06Z cut`;
    expect(locateStepLog(truncated, steps, 2).state).toBe("unidentified");
  });
});
