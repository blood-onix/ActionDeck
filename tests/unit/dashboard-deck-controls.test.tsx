// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../webview/src/dashboard/Dashboard";
import { hostEvent } from "../../src/protocol/envelopes";
import { latestRunPatches } from "../../src/application/workflows/dashboard-service";
import type { ReleasePlan } from "../../src/domain/models/release-plan";
import { makeRun } from "../fixtures/fakes";
import {
  DEFAULT_COLUMN_LAYOUT,
  moveColumn,
  normalizeColumnLayout,
  setColumnHidden,
  setColumnWidth,
} from "../../webview/src/utils/columns";

afterEach(cleanup);

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(id),
    workflowId: id,
    name: `workflow-${id}`,
    path: `.github/workflows/workflow-${id}.yml`,
    folder: "Ungrouped",
    availability: "run_info_not_loaded",
    historyHydration: "not_loaded" as const,
    status: "—",
    title: "—",
    branch: "—",
    actor: "—",
    isMyRun: false,
    duration: "Not available",
    metrics: { passes: 0, failures: 0, sampleSize: 0, scope: "none", passRate: null, averageDurationMs: null },
    ...overrides,
  };
}

function runningPlan(state: ReleasePlan["state"] = "running", stepState: ReleasePlan["steps"][number]["state"] = "running"): ReleasePlan {
  return {
    id: "plan-1",
    name: "Scheduled workflow-1",
    repositoryId: context.id,
    state,
    currentStepIndex: 0,
    updatedAt: 1,
    steps: [{
      id: "step-1",
      workflowId: 1,
      workflowPath: ".github/workflows/workflow-1.yml",
      ref: "main",
      inputs: {},
      sensitiveInputKeys: [],
      gate: "on_success",
      state: stepState,
      runId: 777,
      ...(stepState === "completed" ? { conclusion: "success" } : {}),
    }],
  };
}

function setup(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, (event: ReturnType<typeof hostEvent>) => void>();
  const request = vi.fn(async (operation: string, payload?: unknown) => {
    if (operation === "dashboard.load") {
      return {
        repository: { owner: "acme", repo: "demo", authenticatedUserId: "42" },
        workflows: [row(1), row(2), row(3, { folder: "Deploy" })],
        ...extra,
      };
    }
    if (operation === "run.action") return { state: "accepted" };
    if (operation === "workflow.setGroup") return { groups: {} };
    if (operation === "dashboard.saveColumns") return { saved: true };
    if (operation === "view.openInTab") return { opened: true };
    throw new Error(`unexpected ${operation} ${JSON.stringify(payload)}`);
  });
  const bridge = {
    request,
    onEvent: vi.fn((name: string, listener: (event: ReturnType<typeof hostEvent>) => void) => {
      listeners.set(name, listener);
      return vi.fn();
    }),
  };
  const emit = (name: string, payload: Record<string, unknown>) =>
    act(() => listeners.get(name)?.(hostEvent(`e-${name}`, name, payload)));
  return { bridge, request, emit };
}

describe("live deck updates", () => {
  it("summarizes active runs and only shows evidence-backed exception badges", async () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const running = row(1, {
      status: "in_progress",
      duration: "In progress",
      title: "Build image",
      latestRunId: 101,
      latestRun: makeRun({
        id: 101,
        workflowId: 1,
        status: "in_progress",
        conclusion: null,
        displayTitle: "Build image",
        runStartedAt: startedAt,
        updatedAt: startedAt,
      }),
      metrics: { passes: 0, failures: 0, sampleSize: 0, scope: "none", passRate: null, averageDurationMs: null },
    });
    const flaky = row(2, {
      status: "completed / success",
      latestRunId: 102,
      latestRun: makeRun({ id: 102, workflowId: 2, attemptCount: 2, conclusion: "success" }),
      metrics: { passes: 1, failures: 2, sampleSize: 3, scope: "last 3", passRate: 1 / 3, averageDurationMs: 100_000 },
    });
    const failed = row(3, {
      status: "completed / failure",
      latestRunId: 103,
      latestConclusion: "failure",
      metrics: { passes: 0, failures: 3, sampleSize: 3, scope: "last 3", passRate: 0, averageDurationMs: 80_000 },
    });
    const singleFailure = row(7, {
      status: "completed / failure",
      latestRunId: 107,
      metrics: { passes: 0, failures: 1, sampleSize: 1, scope: "last 1", passRate: 0, averageDurationMs: 5_000 },
    });
    const slow = row(4, {
      status: "completed / success",
      duration: "2m 10s",
      latestRunId: 104,
      metrics: { passes: 5, failures: 0, sampleSize: 5, scope: "last 5", passRate: 1, averageDurationMs: 100_000, medianDurationMs: 100_000 },
    });
    const uncertain = row(5, {
      reconciliation: "not_observed",
      historyHydration: "restricted",
      metrics: { passes: 0, failures: 0, sampleSize: 0, scope: "none", passRate: null, averageDurationMs: null },
    });
    const notVerifiedFlaky = row(6, {
      status: "completed / success",
      latestRunId: 106,
      metrics: { passes: 2, failures: 1, sampleSize: 3, scope: "last 3", passRate: 2 / 3, averageDurationMs: 50_000 },
    });

    const { bridge } = setup({ workflows: [running, flaky, failed, singleFailure, slow, uncertain, notVerifiedFlaky] });
    render(<Dashboard bridge={bridge} />);
    await screen.findAllByText("workflow-1");

    const summary = screen.getByRole("region", { name: "Run activity summary" });
    expect(within(summary).getByText("1 running")).toBeTruthy();
    expect(within(summary).getByText("Build image")).toBeTruthy();
    expect(within(summary).getByText(/1m 30s|1m 31s/)).toBeTruthy();

    expect(screen.getByText("3× in a row")).toBeTruthy();
    expect(screen.queryByText("1× in a row")).toBeNull();
    expect(screen.getAllByText("flaky")).toHaveLength(1);
    expect(screen.getByText("▲ 30%")).toBeTruthy();
    expect(screen.getByText("Run not observed")).toBeTruthy();
    expect(screen.getByText("History restricted")).toBeTruthy();

    const runningRow = document.querySelector('tr[data-row-id="1"]');
    expect(runningRow?.className).toContain("ad-row--running");
    expect(screen.getByLabelText("Notifications for workflow-1")).toBeTruthy();
    expect(screen.getByLabelText("Notifications for workflow-1").closest(".ad-notification-menu")?.querySelector(".codicon-bell")).toBeTruthy();
  });

  it("patches the workflow table from background run observations", async () => {
    const { bridge, emit } = setup();
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("workflow-1");

    emit("runs.observed", {
      repository: { owner: "acme", repo: "demo" },
      runs: latestRunPatches(context, [makeRun({ id: 900, workflowId: 1, branch: "release" })]),
    });
    expect(await screen.findByText("#900")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();

    // Another repository's runs are ignored.
    emit("runs.observed", {
      repository: { owner: "other", repo: "demo" },
      runs: latestRunPatches(context, [makeRun({ id: 901, workflowId: 2 })]),
    });
    expect(screen.queryByText("#901")).toBeNull();
  });

  it("updates a running plan when it finishes and keeps it until dismissed", async () => {
    const { bridge, emit } = setup({ plans: [runningPlan()] });
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("Scheduled workflow-1");

    emit("plan.updated", { plan: runningPlan("completed", "completed") });
    const plan = screen.getByRole("region", { name: "Release Plan Progress" });
    await waitFor(() => expect(within(plan).queryByRole("button", { name: /Pause plan/ })).toBeNull());
    fireEvent.click(within(plan).getByRole("button", { name: /Dismiss/ }));
    expect(screen.queryByText("Scheduled workflow-1")).toBeNull();
  });
});

describe("plan step controls", () => {
  it("opens the step's run and cancels it after confirmation", async () => {
    const { bridge, request } = setup({ plans: [runningPlan()] });
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("Scheduled workflow-1");

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(request).not.toHaveBeenCalledWith("run.action", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /Confirm cancel #777/ }));
    await screen.findByText("Cancel requested");
    expect(request).toHaveBeenCalledWith("run.action", { action: "cancel", runId: 777, attempt: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Open run #777" }));
    expect(await screen.findByText(/Run #777/)).toBeTruthy();
  });
});

describe("grouping", () => {
  it("offers Group… for a selection and moves the rows into the chosen group", async () => {
    const { bridge, request } = setup();
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("workflow-1");
    expect(screen.queryByRole("button", { name: /Group…/ })).toBeNull();

    fireEvent.click(screen.getByLabelText("Select workflow-1"));
    fireEvent.click(screen.getByLabelText("Select workflow-2"));
    fireEvent.click(screen.getByRole("button", { name: "Group… (2)" }));
    const picker = screen.getByRole("region", { name: "Group selected workflows" });
    fireEvent.change(within(picker).getByLabelText("Group name"), { target: { value: "Terraform" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Move to group" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Group selected workflows" })).toBeNull());
    expect(request).toHaveBeenCalledWith("workflow.setGroup", {
      workflowPaths: [".github/workflows/workflow-1.yml", ".github/workflows/workflow-2.yml"],
      group: "Terraform",
    });
    const folders = [...document.querySelectorAll("tr.ad-folder")].map((el) => el.getAttribute("data-folder"));
    expect(folders).toEqual(["Deploy", "Terraform"]);
  });
});

describe("columns", () => {
  it("shows Path as its own column and hides columns from the Columns menu", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridge, request } = setup();
      render(<Dashboard bridge={bridge} />);
      await screen.findByText("workflow-1");
      expect(document.querySelector('th[data-column="path"]')).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Columns" }));
      const menu = screen.getByRole("region", { name: "Table columns" });
      fireEvent.click(within(menu).getByLabelText("Branch"));
      expect(document.querySelector('th[data-column="branch"]')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(request).toHaveBeenCalledWith("dashboard.saveColumns", {
        layout: expect.objectContaining({ hidden: ["availability", "branch"] }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a stored column order from the host", async () => {
    const { bridge } = setup({
      columnLayout: { order: ["lastRun", "path"], hidden: ["notifications"], widths: { name: 200 } },
    });
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("workflow-1");
    const headers = [...document.querySelectorAll("th[data-column]")].map((el) => el.getAttribute("data-column"));
    expect(headers.slice(0, 3)).toEqual(["name", "lastRun", "path"]);
    expect(headers).not.toContain("notifications");
  });

  it("normalizes, moves, hides and clamps column layouts", () => {
    const repaired = normalizeColumnLayout({ order: ["health", "health", "path"], hidden: [], widths: {} });
    expect(new Set(repaired.order).size).toBe(DEFAULT_COLUMN_LAYOUT.order.length);
    expect(repaired.order.indexOf("health")).toBeLessThan(repaired.order.indexOf("path"));
    expect(moveColumn(DEFAULT_COLUMN_LAYOUT, "notifications", 0).order[0]).toBe("notifications");
    expect(setColumnHidden(DEFAULT_COLUMN_LAYOUT, "actor", true).hidden).toEqual(["availability", "actor"]);
    expect(setColumnWidth(DEFAULT_COLUMN_LAYOUT, "name", 5).widths.name).toBe(48);
    expect(setColumnWidth({ ...DEFAULT_COLUMN_LAYOUT, widths: { name: 200 } }, "name", undefined).widths).toEqual({});
  });
});

describe("latestRunPatches", () => {
  it("keeps only the newest run per workflow", () => {
    const patches = latestRunPatches(context, [
      makeRun({ id: 5, workflowId: 1, status: "in_progress", conclusion: null }),
      makeRun({ id: 3, workflowId: 1 }),
      makeRun({ id: 4, workflowId: 2, actor: { id: 42, login: "roman" } }),
    ]);
    expect(patches).toEqual([
      expect.objectContaining({ workflowId: 1, latestRunId: 5, status: "in_progress", duration: "In progress" }),
      expect.objectContaining({ workflowId: 2, latestRunId: 4, isMyRun: true }),
    ]);
  });
});

describe("open in a dedicated tab", () => {
  it("opens the pipeline in its own tab on double-click, Cmd/Ctrl+click and middle-click", async () => {
    const { bridge, request } = setup();
    render(<Dashboard bridge={bridge} />);
    const name = await screen.findByText("workflow-1");
    const rowElement = name.closest("tr")!;
    const target = { kind: "pipeline", workflowPath: ".github/workflows/workflow-1.yml" };

    fireEvent.doubleClick(rowElement);
    expect(request).toHaveBeenCalledWith("view.openInTab", target);

    request.mockClear();
    fireEvent.click(rowElement, { metaKey: true });
    expect(request).toHaveBeenCalledWith("view.openInTab", target);

    request.mockClear();
    fireEvent(rowElement, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(request).toHaveBeenCalledWith("view.openInTab", target);
  });
});
