import * as assert from "node:assert";
import { boundLogExcerpt } from "../../src/domain/services/log-bounds";
import { parseSupportedGitHubRunUrl } from "../../src/domain/services/external-links";
import { inspectRun, type InspectionRepository } from "../../src/application/runs/inspection-service";

suite("ActionDeck run inspection", () => {
  test("opens only supported GitHub run deep links", () => {
    assert.ok(parseSupportedGitHubRunUrl("https://github.com/acme/demo/actions/runs/42"));
    assert.strictEqual(parseSupportedGitHubRunUrl("https://evil.example/acme/demo/actions/runs/42"), undefined);
  });

  test("loads jobs for the explicitly selected attempt", async () => {
    const repository: InspectionRepository = {
      getRun: async () => ({
        id: 42,
        run_number: 8,
        run_attempt: 2,
        display_title: "release",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/demo/actions/runs/42",
      }),
      listJobs: async (_runId, attempt) => ({
        total_count: 1,
        jobs: [{
          id: attempt * 10,
          run_id: 42,
          name: `attempt-${attempt}`,
          status: "completed",
          conclusion: "failure",
          runner_name: null,
          started_at: null,
          completed_at: null,
        }],
      }),
    };

    const inspection = await inspectRun(repository, 42, 1);
    assert.strictEqual(inspection.attempt, 1);
    assert.strictEqual(inspection.jobs[0]?.id, 10);
    assert.strictEqual(inspection.jobs[0]?.attempt, 1);
  });

  test("aborts pending inspection work when its panel request is disposed", async () => {
    const controller = new AbortController();
    const repository: InspectionRepository = {
      getRun: async () => ({
        id: 42,
        run_number: 8,
        run_attempt: 1,
        display_title: "release",
        status: "in_progress",
        conclusion: null,
        html_url: "https://github.com/acme/demo/actions/runs/42",
      }),
      listJobs: async (_runId, _attempt, signal) => {
        if (signal?.aborted) throw new Error("aborted");
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };

    const pending = inspectRun(repository, 42, undefined, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, /aborted/);
  });

  test("keeps bounded log evidence redacted and transient", () => {
    const excerpt = boundLogExcerpt(7, 2, "token=do-not-retain\nsafe output");
    const serialized = JSON.stringify(excerpt);
    assert.ok(serialized.includes("[REDACTED]"));
    assert.ok(!serialized.includes("do-not-retain"));
    assert.ok(serialized.includes("safe output"));
  });
});
