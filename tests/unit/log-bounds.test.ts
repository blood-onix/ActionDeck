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
