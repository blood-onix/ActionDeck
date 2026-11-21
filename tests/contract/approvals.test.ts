import { describe, expect, it } from "vitest";
import {
  approvalRuleSavePayload,
  deploymentReviewPayload,
  subscriptionUpdatePayload,
} from "../../src/protocol/approvals";

describe("Approval and notification protocol contracts", () => {
  it("validates subscription, deployment review, and opt-in approval rule payloads", () => {
    expect(subscriptionUpdatePayload.safeParse({
      workflowId: 7,
      mode: "my_runs_only",
    }).success).toBe(true);

    expect(deploymentReviewPayload.safeParse({
      runId: 42,
      environmentIds: [10],
      state: "approved",
      comment: "Ship it",
    }).success).toBe(true);

    expect(deploymentReviewPayload.safeParse({
      runId: 42,
      environmentIds: [],
      state: "approved",
    }).success).toBe(false);

    expect(approvalRuleSavePayload.safeParse({
      id: "rule-1",
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      enabled: false,
    }).success).toBe(true);
  });
});
