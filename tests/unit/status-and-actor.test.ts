import { describe, expect, it } from "vitest";
import { primaryRepository, summarizePlanStatus } from "../../src/application/plans/plan-summary";
import { NotificationService } from "../../src/application/runs/notification-service";
import { SubscriptionStore } from "../../src/persistence/subscription-store";
import { formatRelativeTime } from "../../src/domain/services/relative-time";
import { latestRunsByWorkflowPath } from "../../src/application/workflows/latest-run";
import { InMemoryStateStore, makeRun } from "../fixtures/fakes";
import type { ReleasePlan } from "../../src/domain/models/release-plan";

const plan = (id: string, state: ReleasePlan["state"]): ReleasePlan => ({
  id, name: id, repositoryId: "r", state, steps: [], currentStepIndex: 0, updatedAt: 0,
});

describe("cross-repository plan status", () => {
  it("aggregates plans and approvals across repositories and picks the repository needing attention", () => {
    const statuses = new Map([
      ["a", { plans: [plan("1", "running"), plan("2", "scheduled")], pendingApprovals: 0 }],
      ["b", { plans: [plan("3", "blocked_uncertain"), plan("4", "completed")], pendingApprovals: 2 }],
    ]);
    expect(summarizePlanStatus(statuses.values())).toEqual({ active: 1, scheduled: 1, blocked: 1, pendingApprovals: 2 });
    expect(primaryRepository(statuses)).toBe("b");
  });
});

describe("actor identity and approval prompts", () => {
  it("matches the stable original actor ID rather than the login and dedupes approval prompts", () => {
    const service = new NotificationService(new SubscriptionStore(new InMemoryStateStore()));
    const renamed = makeRun({ id: 5, status: "waiting", conclusion: null, actor: { id: 42, login: "renamed" } });
    expect(service.shouldPromptApproval("r", "roman", "42", renamed, 1)).toBe(true);
    expect(service.shouldPromptApproval("r", "roman", "42", renamed, 1)).toBe(false);
    const other = makeRun({ id: 6, status: "waiting", conclusion: null, actor: { id: 99, login: "roman" } });
    expect(service.shouldPromptApproval("r", "roman", "42", other, 1)).toBe(false);
  });

  it("reports the triggering actor separately on reruns", () => {
    const service = new NotificationService(new SubscriptionStore(new InMemoryStateStore()));
    const [first] = service.evaluate("r", "roman", [makeRun({
      id: 7, actor: { id: 42, login: "roman" }, triggeringActor: { id: 9, login: "bob" },
    })], false, "42");
    expect(first?.triggeringActor).toBe("bob");
  });
});

describe("latest run summaries", () => {
  it("keeps the newest run per workflow path and formats relative time", () => {
    const latest = latestRunsByWorkflowPath([
      makeRun({ id: 1, workflowPath: ".github/workflows/ci.yml", createdAt: "2026-01-01T00:00:00Z", conclusion: "failure" }),
      makeRun({ id: 2, workflowPath: ".github/workflows/CI.yml", createdAt: "2026-01-02T00:00:00Z", conclusion: "success" }),
    ]);
    expect(latest.get(".github/workflows/ci.yml")?.conclusion).toBe("success");
    const now = Date.parse("2026-01-01T03:00:00Z");
    expect(formatRelativeTime("2026-01-01T00:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-01-01T02:59:50Z", now)).toBe("just now");
    expect(formatRelativeTime("not-a-date", now)).toBeUndefined();
  });
});
