// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingApprovals } from "../../webview/src/inspector/PendingApprovals";

afterEach(cleanup);

const htmlUrl = "https://github.com/acme/demo/actions/runs/77";

describe("inspector pending approvals", () => {
  it("lets an eligible reviewer approve a waiting gate from the run inspector", async () => {
    let pending = [{ environmentId: 3, environmentName: "dev", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 }];
    const onReviewed = vi.fn();
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "deployment.list") return { runId: 77, environments: pending };
        pending = [];
        return { runId: 77, results: [{ environmentId: 3, status: "succeeded" }] };
      }),
    };
    render(<PendingApprovals bridge={bridge} runId={77} workflowName="Terraform" status="waiting" htmlUrl={htmlUrl} onReviewed={onReviewed} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("deployment.review", {
      runId: 77, environmentIds: [3], state: "approved",
    }));
    expect(onReviewed).toHaveBeenCalled();
  });

  it("explains a gate the account cannot approve and links to GitHub", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "deployment.list") {
          return {
            runId: 77,
            environments: [{
              environmentId: 3,
              environmentName: "dev",
              eligible: false,
              currentUserCanApprove: false,
              waitTimerRemainingSeconds: 0,
              requiredReviewers: ["team-twins-infra"],
              reason: "Authenticated user is not an authorized reviewer for this environment.",
            }],
          };
        }
        return undefined;
      }),
    };
    render(<PendingApprovals bridge={bridge} runId={77} workflowName="Terraform" status="waiting" htmlUrl={htmlUrl} />);
    expect(await screen.findByText(/not an authorized reviewer/)).toBeTruthy();
    expect(screen.getByText(/team-twins-infra/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Review on GitHub/ }));
    expect(bridge.request).toHaveBeenCalledWith("external.open", { url: htmlUrl });
  });

  it("renders nothing for a run that is not waiting", () => {
    const bridge = { request: vi.fn() };
    const { container } = render(<PendingApprovals bridge={bridge} runId={77} workflowName="Terraform" status="in_progress" htmlUrl={htmlUrl} />);
    expect(container.innerHTML).toBe("");
    expect(bridge.request).not.toHaveBeenCalled();
  });
});
