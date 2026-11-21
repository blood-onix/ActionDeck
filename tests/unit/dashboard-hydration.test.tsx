// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../webview/src/dashboard/Dashboard";
import { buildDashboard } from "../../src/application/workflows/dashboard-service";
import { dashboardDataSchema } from "../../src/protocol/dashboard";
import { makeRemoteWorkflow, makeRun, makeWorkflow } from "../fixtures/fakes";

afterEach(cleanup);

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

function dashboardPayload(extra: Record<string, unknown> = {}) {
  const local = [makeWorkflow(1, { name: "Build pipeline" }), makeWorkflow(2, { name: "Deploy pipeline" })];
  const remote = [makeRemoteWorkflow(1, { name: "Build pipeline" }), makeRemoteWorkflow(2, { name: "Deploy pipeline" })];
  const runs = [
    makeRun({
      id: 11,
      workflowId: 1,
      status: "completed",
      conclusion: "failure",
      updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      actor: { id: 42, login: "roman" },
      triggeringActor: { id: 7, login: "teammate" },
    }),
    makeRun({ id: 12, workflowId: 2, status: "completed", conclusion: "success" }),
  ];
  return dashboardDataSchema.parse({
    ...buildDashboard(context, local, remote, runs, false, undefined, new Map([[2, "muted" as const]])),
    ...extra,
  });
}

describe("dashboard hydration and interactions", () => {
  it("shows latest conclusion, relative time, rerun actor, and persisted notification modes", async () => {
    const bridge = { request: vi.fn().mockResolvedValue(dashboardPayload()) };
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("Build pipeline");
    expect(screen.getByText(/2h ago/)).toBeTruthy();
    expect(screen.getByText(/re-run by teammate/)).toBeTruthy();
    expect((screen.getByLabelText("Notifications for Build pipeline") as HTMLSelectElement).value).toBe("my_runs_only");
    expect((screen.getByLabelText("Notifications for Deploy pipeline") as HTMLSelectElement).value).toBe("muted");

    fireEvent.change(screen.getByLabelText("Notifications for Build pipeline"), { target: { value: "all_runs" } });
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("subscription.update", { workflowId: 1, mode: "all_runs" }));
  });

  it("hydrates persisted plans and rules, and opens the Action Center directly from the status bar view", async () => {
    const plan = {
      id: "plan-1",
      name: "Persisted release",
      repositoryId: context.id,
      state: "blocked_uncertain",
      currentStepIndex: 0,
      updatedAt: 1,
      blockedReason: "Outcome uncertain",
      steps: [{
        id: "s1",
        workflowId: 1,
        workflowPath: ".github/workflows/build.yml",
        ref: "main",
        inputs: {},
        sensitiveInputKeys: [],
        gate: "stop_on_non_success",
        state: "outcome_uncertain",
      }],
    };
    const rule = {
      id: "rule-1",
      repositoryId: context.id,
      workflowId: 1,
      environmentName: "staging",
      ref: "main",
      authenticatedUserId: "42",
      enabled: true,
      createdAt: 1,
    };
    const bridge = {
      request: vi.fn().mockResolvedValue(dashboardPayload({
        plans: [plan],
        approvalRules: [rule],
        approvalAudit: [{ timestamp: 5, runId: 9, workflowId: 1, environmentId: 1, environmentName: "staging", ruleId: "rule-1", status: "succeeded" }],
        initialView: "action-center",
      })),
    };
    render(<Dashboard bridge={bridge} />);
    await screen.findByRole("complementary", { name: "Action Center" });
    expect(screen.getAllByText(/Persisted release/).length).toBeGreaterThan(0);
    expect(screen.getByText(/staging · main/)).toBeTruthy();
    expect(screen.getByLabelText("Auto-approval audit")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Explain why this plan is blocked" }).length).toBeGreaterThan(0);
  });

  it("moves focus between rows with treegrid arrow keys, toggles folders with Left/Right, and opens/closes the drawer 10 times preserving state", async () => {
    const bridge = {
      request: vi.fn((op: string) => {
        if (op === "dashboard.load") return Promise.resolve(dashboardPayload());
        return Promise.resolve({
          runId: 11,
          attempt: 1,
          attemptCount: 1,
          title: "Build pipeline",
          status: "completed",
          conclusion: "failure",
          htmlUrl: "https://github.com/acme/demo/actions/runs/11",
          dependencyResolution: "resolved",
          jobs: [],
        });
      }),
    };
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("Build pipeline");

    const grid = screen.getByRole("treegrid", { name: "Workflows" });
    expect(grid).toBeTruthy();

    const rows = document.querySelectorAll<HTMLElement>("tr[data-row-id]");
    expect(rows.length).toBe(2);
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    // Moves onto the next folder row, then ArrowDown again reaches rows[1]
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);

    // Select row 0 with Space, set filter & scrollTop, then open/close drawer 10 times
    fireEvent.keyDown(rows[0]!, { key: " " });
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    const scrollRegion = document.querySelector(".table-wrap") as HTMLDivElement;
    scrollRegion.scrollTop = 42;

    for (let i = 0; i < 10; i++) {
      rows[0]!.focus();
      fireEvent.keyDown(rows[0]!, { key: "Enter" });
      const drawer = await screen.findByRole("complementary");
      expect(drawer).toBeTruthy();
      fireEvent.keyDown(drawer, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    }

    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(scrollRegion.scrollTop).toBe(42);
  });
});
