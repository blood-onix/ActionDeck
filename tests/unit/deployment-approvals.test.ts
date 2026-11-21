import { describe, expect, it, vi } from "vitest";
import { listPendingDeploymentSummaries, reviewPendingDeployments } from "../../src/application/approvals/approval-service";
import { AutoApprovalService } from "../../src/application/approvals/auto-approval-service";
import { ApprovalRuleStore } from "../../src/persistence/approval-rule-store";
import { UiAuthorization } from "../../src/application/dispatch/authorization";
import { AppError } from "../../src/domain/models/errors";
import { InMemoryStateStore } from "../fixtures/fakes";

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

describe("Deployment approvals & deterministic auto-approval rules", () => {
  it("requires explicit environment selection, reports non-atomic outcomes, and never retries uncertain reviews", async () => {
    const auth = new UiAuthorization();
    auth.authorize({
      repositoryId: context.id,
      target: "review:run:42:envs:10,11",
      ref: "approved",
      inputs: { comment: "LGTM" },
    });

    const submitReview = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError("network", "Timeout during review"));

    const results = await reviewPendingDeployments(
      { submitReview },
      context,
      auth,
      {
        runId: 42,
        environmentIds: [10, 11],
        state: "approved",
        comment: "LGTM",
      },
    );

    expect(submitReview).toHaveBeenCalledTimes(2);
    expect(results[0]?.status).toBe("succeeded");
    expect(results[1]?.status).toBe("outcome_uncertain");
  });

  it("keeps auto-approval rules disabled by default, requires exact metadata match, and halts on identity change", async () => {
    const store = new ApprovalRuleStore(new InMemoryStateStore());
    const service = new AutoApprovalService(store);

    const saved = await service.saveRule({
      id: "rule-1",
      repositoryId: context.id,
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      authenticatedUserId: "42",
      enabled: false,
      createdAt: 1_000,
    });
    expect(saved.enabled).toBe(false);

    // Disabled by default -> no match
    expect(service.findMatchingRule(context, {
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      originalActorId: "42",
      eligible: true,
    })).toBeUndefined();

    await service.setRuleEnabled(context.id, "rule-1", true);

    // Near miss on ref -> no match
    expect(service.findMatchingRule(context, {
      workflowId: 7,
      environmentName: "staging",
      ref: "release",
      originalActorId: "42",
      eligible: true,
    })).toBeUndefined();

    // Exact match -> matches
    expect(service.findMatchingRule(context, {
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      originalActorId: "42",
      eligible: true,
    })?.id).toBe("rule-1");

    // Identity change immediately halts automated approvals
    await service.haltAllOnIdentityChange(context.id);
    expect(service.findMatchingRule(context, {
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      originalActorId: "42",
      eligible: true,
    })).toBeUndefined();
  });

  it("summarizes waiting deployment approvals and user eligibility safely", async () => {
    const summaries = await listPendingDeploymentSummaries(
      {
        loadRecent: async () => ({
          runs: [
            {
              id: 50,
              workflowId: 7,
              attemptCount: 1,
              hydration: "summary",
              displayTitle: "Deploy token=ghp_1234567890abcdefghij",
              status: "waiting",
              conclusion: null,
              event: "workflow_dispatch",
              branch: "main",
              headSha: "abc",
              createdAt: "2026-11-14T00:00:00Z",
              updatedAt: "2026-11-14T00:00:00Z",
              htmlUrl: "https://github.com/acme/demo/actions/runs/50",
            },
            {
              id: 51,
              workflowId: 7,
              attemptCount: 1,
              hydration: "summary",
              displayTitle: "Queued build",
              status: "queued",
              conclusion: null,
              event: "push",
              branch: "main",
              headSha: "def",
              createdAt: "2026-11-14T00:00:00Z",
              updatedAt: "2026-11-14T00:00:00Z",
              htmlUrl: "https://github.com/acme/demo/actions/runs/51",
            },
          ],
        }),
      },
      {
        listPendingDeployments: async (runId) =>
          runId === 50
            ? [
              {
                environmentId: 1,
                environmentName: "production",
                eligible: true,
                currentUserCanApprove: true,
                waitTimerRemainingSeconds: 0,
              },
            ]
            : [],
      },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.runId).toBe(50);
    expect(summaries[0]?.displayTitle).not.toContain("ghp_");
    expect(summaries[0]?.environments[0]?.eligible).toBe(true);
  });
});
