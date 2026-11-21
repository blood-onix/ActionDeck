import { describe, expect, it } from "vitest";
import { NotificationService } from "../../src/application/runs/notification-service";
import { SubscriptionStore } from "../../src/persistence/subscription-store";
import { InMemoryStateStore, makeRun } from "../fixtures/fakes";

describe("Actor-scoped notifications & subscription deduplication", () => {
  it("suppresses initial-hydration and teammate runs by default, and deduplicates by run/attempt", async () => {
    const store = new SubscriptionStore(new InMemoryStateStore());
    const service = new NotificationService(store);
    const repoId = "acme/demo|origin|file:///repo";

    // Initial hydration: should record watermark and emit zero toasts
    const initial = service.evaluate(repoId, "alice", [
      makeRun({ id: 1, attemptCount: 1, status: "completed", conclusion: "failure", actor: { login: "alice" } }),
      makeRun({ id: 2, attemptCount: 1, status: "completed", conclusion: "failure", actor: { login: "bob" } }),
    ], true);
    expect(initial).toEqual([]);

    // Subsequent poll: teammate run suppressed under my_runs_only; own new run notified once
    const nextRuns = [
      makeRun({ id: 3, attemptCount: 1, status: "completed", conclusion: "failure", actor: { login: "bob" } }),
      makeRun({
        id: 4,
        attemptCount: 1,
        status: "completed",
        conclusion: "success",
        actor: { login: "alice" },
        triggeringActor: { login: "bob" },
      }),
    ];
    const firstEmit = service.evaluate(repoId, "alice", nextRuns, false);
    expect(firstEmit.map((n) => n.runId)).toEqual([4]);

    const duplicateEmit = service.evaluate(repoId, "alice", nextRuns, false);
    expect(duplicateEmit).toEqual([]);

    // Override workflow to all_runs
    await store.setWorkflowMode(repoId, 1, "all_runs");
    const teammateAfterOptIn = service.evaluate(repoId, "alice", [
      makeRun({ id: 5, workflowId: 1, attemptCount: 1, status: "completed", conclusion: "failure", actor: { login: "bob" } }),
    ], false);
    expect(teammateAfterOptIn.map((n) => n.runId)).toEqual([5]);
  });
});
