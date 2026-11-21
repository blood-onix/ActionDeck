// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ActionCenter } from "../../webview/src/dashboard/ActionCenter";
import type { Bridge } from "../../webview/src/bridge";

afterEach(cleanup);

describe("ActionCenter UI", () => {
  it("distinguishes actionable approval counts from ordinary queued runs and renders per-environment review", async () => {
    const request = vi.fn().mockResolvedValue({
      runId: 42,
      environments: [
        { environmentId: 10, environmentName: "staging", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
        { environmentId: 11, environmentName: "production", eligible: false, currentUserCanApprove: false, reason: "Required reviewer missing", waitTimerRemainingSeconds: 0 },
      ],
    });
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;

    render(
      <ActionCenter
        bridge={bridge}
        pendingRunIds={[42]}
        queuedCount={5}
        approvalWaitCount={1}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/1 awaiting approval/i)).toBeTruthy();
    expect(screen.getByText(/5 queued/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Load pending environments/i }));
    await screen.findByText(/staging/i);
    expect(screen.getByText(/Required reviewer missing/i)).toBeTruthy();
  });
});

describe("ActionCenter review flows", () => {
  const env = (id: number, name: string) => ({
    environmentId: id,
    environmentName: name,
    eligible: true,
    currentUserCanApprove: true,
    waitTimerRemainingSeconds: 0,
    requiredReviewers: ["alice"],
  });

  it("offers direct approve for a single environment and links to the run inspector", async () => {
    const request = vi.fn(async (operation: string) => operation === "deployment.list"
      ? { runId: 42, environments: [env(10, "staging")] }
      : [{ environmentId: 10, status: "succeeded" }]);
    const onInspectRun = vi.fn();
    render(
      <ActionCenter
        bridge={{ request } as unknown as Bridge}
        pendingRunIds={[42]}
        pendingRuns={[{ runId: 42, workflowName: "Deploy", branch: "main" }]}
        queuedCount={0}
        approvalWaitCount={1}
        onInspectRun={onInspectRun}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Load pending environments/i }));
    await screen.findByText(/Reviewers: alice/);
    fireEvent.click(screen.getAllByRole("button", { name: "Inspect run" })[0]!);
    expect(onInspectRun).toHaveBeenCalledWith(42);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(/Run #42 · environment 10/);
    expect(request).toHaveBeenCalledWith("deployment.review", { runId: 42, environmentIds: [10], state: "approved", comment: "" });
  });

  it("requires explicit selection for multiple environments and reviews across runs", async () => {
    const request = vi.fn(async (operation: string, payload: { runId: number }) => operation === "deployment.list"
      ? { runId: payload.runId, environments: payload.runId === 1 ? [env(10, "staging"), env(11, "prod")] : [env(12, "staging")] }
      : (payload as unknown as { environmentIds: number[] }).environmentIds.map((environmentId) => ({ environmentId, status: "succeeded" })));
    render(
      <ActionCenter
        bridge={{ request } as unknown as Bridge}
        pendingRunIds={[1, 2]}
        queuedCount={0}
        approvalWaitCount={2}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Load all pending runs/i }));
    await screen.findByLabelText("Select staging on run #1");
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[2]!);
    fireEvent.click(screen.getByRole("button", { name: "Approve 2 deployments" }));
    await screen.findByText(/Run #2 · environment 12/);
    expect(request).toHaveBeenCalledWith("deployment.review", { runId: 1, environmentIds: [10], state: "approved", comment: "" });
    expect(request).toHaveBeenCalledWith("deployment.review", { runId: 2, environmentIds: [12], state: "approved", comment: "" });
  });

  it("renders Explain why this plan is blocked for blocked plans and displays the explanation", async () => {
    const request = vi.fn().mockResolvedValue({
      mode: "fallback",
      observedFacts: ["Step 1 failed on main."],
      likelyExplanations: ["Missing environment secret."],
      suggestedNextSteps: ["Inspect run #99."],
      limitations: [],
    });
    render(
      <ActionCenter
        bridge={{ request } as unknown as Bridge}
        pendingRunIds={[]}
        queuedCount={0}
        approvalWaitCount={0}
        plans={[{
          id: "plan-1",
          name: "Prod Release",
          repositoryId: "repo-1",
          state: "blocked_uncertain",
          blockedReason: "Ambiguous dispatch association",
          steps: [],
          currentStepIndex: 0,
          updatedAt: Date.now(),
        }]}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Explain why this plan is blocked" }));
    await screen.findByText(/Step 1 failed on main\./);
    expect(request).toHaveBeenCalledWith("plan.explainBlocked", { planId: "plan-1" });
    expect(screen.getByText(/Missing environment secret\./)).toBeTruthy();
    expect(screen.getByText(/Inspect run #99\./)).toBeTruthy();
  });
});
