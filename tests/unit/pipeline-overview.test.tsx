// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineOverview } from "../../webview/src/pipeline/PipelineOverview";
import { Dashboard } from "../../webview/src/dashboard/Dashboard";
import { buildDashboard } from "../../src/application/workflows/dashboard-service";
import { makeRemoteWorkflow, makeRun, makeWorkflow } from "../fixtures/fakes";

afterEach(cleanup);

const metrics = { passes: 1, failures: 1, sampleSize: 2, scope: "last 2", passRate: 0.5, averageDurationMs: 90_000 };

function pageRuns(page: number) {
  return [
    makeRun({ id: page * 10 + 1, displayTitle: `Deploy page ${page}`, conclusion: "success", workflowId: 1 }),
    makeRun({ id: page * 10 + 2, displayTitle: `Broken page ${page}`, conclusion: "failure", workflowId: 1 }),
  ];
}

/** Mimics the host: every response carries all pages loaded so far, merged newest first. */
function historyBridge(hasMore = false) {
  return {
    request: vi.fn((operation: string, payload?: { page?: number }) => {
      if (operation === "workflow.history.load") {
        const page = payload?.page ?? 1;
        return Promise.resolve({
          runs: Array.from({ length: page }, (_, index) => pageRuns(index + 1)).flat(),
          metrics,
          hasMore: hasMore && page === 1,
          page,
          totalCount: hasMore ? 4 : 2,
        });
      }
      return new Promise(() => {});
    }),
  };
}

describe("pipeline overview", () => {
  it("lists recent runs, pages history, and inspects a run on click", async () => {
    const bridge = historyBridge(true);
    const onInspectRun = vi.fn();
    render(
      <PipelineOverview
        bridge={bridge}
        workflow={{ workflowId: 1, workflowPath: ".github/workflows/deploy.yml", workflowName: "deploy" }}
        plans={[]}
        onInspectRun={onInspectRun}
        onPlanSaved={vi.fn()}
      />,
    );
    await screen.findByText("Deploy page 1");
    expect(screen.getByText("2 of 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more runs" }));
    await screen.findByText("Deploy page 2");
    expect(bridge.request).toHaveBeenLastCalledWith("workflow.history.load", { workflowId: 1, page: 2 }, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Load more runs" })).toBeNull();
    fireEvent.click(screen.getByText("Broken page 1"));
    expect(onInspectRun).toHaveBeenCalledWith(12);
  });

  it("links to the dispatched run and refreshes the run list when returning to Runs", async () => {
    const onInspectRun = vi.fn();
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "workflow.history.load") {
        return { runs: pageRuns(1), metrics, hasMore: false, page: 1, totalCount: 2, ...(payload.cached ? { cachedAt: 1 } : {}) };
      }
      if (operation === "repository.branches") return { names: ["main"], truncated: false, cachedAt: 1 };
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/deploy.yml", dispatchable: true, inputs: [], warning: "preview" };
      }
      if (operation === "dispatch.submit") {
        return { state: "associated_run_found", runId: 99, runStatus: "queued", htmlUrl: "https://github.com/acme/demo/actions/runs/99" };
      }
      return {
        target: { state: "available", workflowId: 1, ref: "main", defaultBranch: "main", inputs: [] },
        validation: { valid: true, values: {}, errors: {} },
        ...(payload.review ? { reviewToken: "c35c7c97-5d81-4531-a867-16a99ce0717f" } : {}),
      };
    });
    render(
      <PipelineOverview
        bridge={{ request }}
        workflow={{ workflowId: 1, workflowPath: ".github/workflows/deploy.yml", workflowName: "deploy" }}
        plans={[]}
        onInspectRun={onInspectRun}
        onPlanSaved={vi.fn()}
      />,
    );
    await screen.findByText("Deploy page 1");
    fireEvent.click(screen.getByRole("tab", { name: "Run now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run workflow" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open run #99" }));
    expect(onInspectRun).toHaveBeenCalledWith(99);
    fireEvent.click(screen.getByRole("button", { name: "View on GitHub" }));
    expect(request).toHaveBeenCalledWith("external.open", { url: "https://github.com/acme/demo/actions/runs/99" });

    const historyCalls = () => request.mock.calls.filter(([operation]) => operation === "workflow.history.load").length;
    const before = historyCalls();
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    await waitFor(() => expect(historyCalls()).toBe(before + 1));
    fireEvent.click(screen.getByRole("tab", { name: "Run now" }));
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(historyCalls()).toBe(before + 1);
  });

  it("presents sampled metrics, accessible duration bars, and honest summary evidence", async () => {
    const timedRuns = [
      makeRun({
        id: 21,
        displayTitle: "Retried build",
        attemptCount: 2,
        conclusion: "success",
        createdAt: "2026-01-01T00:00:00Z",
        runStartedAt: "2026-01-01T00:00:10Z",
        completedAt: "2026-01-01T00:02:10Z",
      }),
      makeRun({
        id: 22,
        displayTitle: "Failed deploy",
        conclusion: "failure",
        createdAt: "2026-01-01T01:00:00Z",
        runStartedAt: "2026-01-01T01:00:30Z",
        completedAt: "2026-01-01T01:01:30Z",
      }),
    ];
    const bridge = {
      request: vi.fn((operation: string) => operation === "workflow.history.load"
        ? Promise.resolve({ runs: timedRuns, metrics, hasMore: false, page: 1, totalCount: 2 })
        : new Promise(() => {})),
    };
    const onInspectRun = vi.fn();
    render(
      <PipelineOverview
        bridge={bridge}
        workflow={{ workflowId: 1, workflowPath: ".github/workflows/deploy.yml", workflowName: "deploy" }}
        plans={[]}
        onInspectRun={onInspectRun}
        onPlanSaved={vi.fn()}
      />,
    );

    expect(await screen.findByText("2 completed runs sampled")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("1m 30s")).toBeTruthy();
    expect(screen.getByText("20s")).toBeTruthy();
    expect(screen.getByText("▲ 33% last run")).toBeTruthy();
    expect(screen.getByText("2 known")).toBeTruthy();
    expect(screen.getByText("Passed on retry")).toBeTruthy();
    const bar = screen.getByRole("button", { name: /Run #21: Success, 2m 00s, queued 10s/ });
    expect(bar.className).toContain("ad-pipeline__bar--success");
    fireEvent.click(bar);
    expect(onInspectRun).toHaveBeenCalledWith(21);
    expect(screen.queryByText(/failing step unavailable/)).toBeNull();
    expect(screen.getByText("flaky · attempt 2")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Run workflow" })).toBeNull();
  });

  it("shows cached runs immediately, then refreshes only the newest page", async () => {
    let resolveFresh: ((value: unknown) => void) | undefined;
    const bridge = {
      request: vi.fn((operation: string, payload?: { cached?: boolean }) => {
        if (operation !== "workflow.history.load") return new Promise(() => {});
        if (payload?.cached) {
          return Promise.resolve({ runs: pageRuns(1), metrics, hasMore: false, page: 1, totalCount: 2, cachedAt: Date.now() - 120_000 });
        }
        return new Promise((resolve) => { resolveFresh = resolve; });
      }),
    };
    render(
      <PipelineOverview
        bridge={bridge}
        workflow={{ workflowId: 1, workflowPath: ".github/workflows/deploy.yml", workflowName: "deploy" }}
        plans={[]}
        onInspectRun={vi.fn()}
        onPlanSaved={vi.fn()}
      />,
    );
    await screen.findByText("Deploy page 1");
    expect(screen.getByRole("status").textContent).toMatch(/cached 2m ago · updating/);
    expect(bridge.request).toHaveBeenNthCalledWith(1, "workflow.history.load", { workflowId: 1, page: 1, cached: true }, expect.any(AbortSignal));
    expect(bridge.request).toHaveBeenNthCalledWith(2, "workflow.history.load", { workflowId: 1, page: 1 }, expect.any(AbortSignal));
    resolveFresh?.({
      runs: [makeRun({ id: 99, displayTitle: "Brand new run", workflowId: 1 }), ...pageRuns(1)],
      metrics,
      hasMore: false,
      page: 1,
      totalCount: 3,
    });
    await screen.findByText("Brand new run");
    expect(screen.getByText("Deploy page 1")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("switches to the run form and schedule tabs for the same workflow", async () => {
    const bridge = historyBridge();
    render(
      <PipelineOverview
        bridge={bridge}
        workflow={{ workflowId: 1, workflowPath: ".github/workflows/deploy.yml", workflowName: "deploy", defaultBranch: "main" }}
        plans={[]}
        onInspectRun={vi.fn()}
        onPlanSaved={vi.fn()}
      />,
    );
    await screen.findByText("Deploy page 1");
    fireEvent.click(screen.getByRole("tab", { name: "Run now" }));
    expect(screen.getByLabelText("Workflow Companion")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Schedule" }));
    expect(screen.getByText("Schedule deploy")).toBeTruthy();
    expect((screen.getByLabelText("Schedule mode") as HTMLSelectElement).value).toBe("relative");
    expect(screen.getByText(".github/workflows/deploy.yml")).toBeTruthy();
  });

  it("explains that a local-only workflow must be pushed first", () => {
    render(
      <PipelineOverview
        bridge={historyBridge()}
        workflow={{ workflowPath: ".github/workflows/new.yml", workflowName: "new" }}
        plans={[]}
        onInspectRun={vi.fn()}
        onPlanSaved={vi.fn()}
      />,
    );
    expect(screen.getByText("Not on GitHub yet")).toBeTruthy();
  });

  it("opens as its own focused tab from the pipeline entry point and returns from a run to the pipeline", async () => {
    const dashboard = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1), makeWorkflow(2)], [makeRemoteWorkflow(1), makeRemoteWorkflow(2)], [], false);
    const bridge = {
      request: vi.fn((operation: string, payload?: { page?: number }) => {
        if (operation === "dashboard.load") {
          return Promise.resolve({ ...dashboard, initialWorkflowPath: ".github/workflows/workflow-1.yml", initialAction: "pipeline" });
        }
        return historyBridge().request(operation, payload);
      }),
    };
    const { container } = render(<Dashboard bridge={bridge} />);
    await screen.findByText("Deploy page 1");
    expect(container.querySelector(".ad-drawer-host--focused")).toBeTruthy();
    fireEvent.click(screen.getByText("Deploy page 1"));
    const back = await screen.findByRole("button", { name: "Back" });
    expect(screen.queryByLabelText("workflow-1 pipeline")).toBeNull();
    fireEvent.click(back);
    await screen.findByLabelText("workflow-1 pipeline");
    expect(container.querySelector(".ad-drawer-host--focused")).toBeTruthy();
  });
});
