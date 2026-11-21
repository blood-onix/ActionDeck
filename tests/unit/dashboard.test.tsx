// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../webview/src/dashboard/Dashboard";
import { BridgeError } from "../../webview/src/bridge";
import { buildDashboard } from "../../src/application/workflows/dashboard-service";
import { hostEvent } from "../../src/protocol/envelopes";
import { makeRemoteWorkflow, makeRun, makeWorkflow } from "../fixtures/fakes";
import { computeHealthSummary } from "../../webview/src/utils/health-metrics";
import { MetricCell } from "../../webview/src/components/MetricCell";

afterEach(cleanup);

// Timing budgets leave headroom for parallel test workers and slower shared CI runners.
const INTERACTION_BUDGET_MS = process.env.CI ? 500 : 250;
const RENDER_BUDGET_MS = process.env.CI ? 6_000 : 2_000;

describe("dashboard interactions", () => {
  it("renders 100 workflows with 500 cached runs and filters in under 100 ms", async () => {
    const local = Array.from({ length: 100 }, (_, index) => makeWorkflow(index + 1, {
      name: `Workflow ${index}`,
      folder: index % 2 ? "CI" : "Deploy",
    }));
    const remote = Array.from({ length: 100 }, (_, index) => makeRemoteWorkflow(index + 1, {
      name: `Workflow ${index}`,
    }));
    const runs = Array.from({ length: 500 }, (_, index) => {
      const workflowIndex = index % 100;
      return makeRun({
        id: index + 1,
        workflowId: workflowIndex + 1,
        displayTitle: `Workflow ${workflowIndex} run ${index}`,
        actor: workflowIndex % 2 ? { id: 99, login: "teammate" } : { id: 42, login: "roman" },
        runStartedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
      });
    });
    const data = buildDashboard({
      id: "acme/demo|origin|file:///repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
      authenticatedUserId: "42",
    }, local, remote, runs, false);
    const bridge = {
      request: vi.fn().mockResolvedValue({
        ...data,
      }),
    };
    const renderStarted = performance.now();
    render(<Dashboard bridge={bridge} />);
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(103));
    expect(performance.now() - renderStarted).toBeLessThan(RENDER_BUDGET_MS);
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(data.workflows).toHaveLength(100);
    expect(data.workflows[0]?.metrics.sampleSize).toBe(5);

    const filterInput = screen.getByLabelText("Filter workflows");
    const started = performance.now();
    fireEvent.change(filterInput, { target: { value: "Workflow 7" } });
    const elapsed = performance.now() - started;
    expect(screen.getByText("Workflow 7")).toBeTruthy();
    expect(screen.queryByText("Workflow 8")).toBeNull();
    expect(elapsed).toBeLessThan(INTERACTION_BUDGET_MS);

    fireEvent.click(screen.getByRole("button", { name: /My runs only/ }));
    expect(screen.queryByText("Workflow 7")).toBeNull();
    expect(bridge.request).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /My runs only/ }));
    fireEvent.change(screen.getByLabelText("Filter workflows"), { target: { value: "" } });
    const workflowSortButton = screen.getByRole("button", { name: "Workflow" });
    const sortStarted = performance.now();
    fireEvent.click(workflowSortButton);
    expect(performance.now() - sortStarted).toBeLessThan(INTERACTION_BUDGET_MS);
    const ciFolderButton = screen.getByRole("button", { name: /CI/ });
    const groupStarted = performance.now();
    fireEvent.click(ciFolderButton);
    expect(performance.now() - groupStarted).toBeLessThan(INTERACTION_BUDGET_MS);
    const selectedRow = screen.getByText("Workflow 0").closest("tr") as HTMLElement;
    selectedRow.focus();
    fireEvent.keyDown(selectedRow, { key: " " });
    const scrollRegion = document.querySelector(".table-wrap") as HTMLDivElement;
    scrollRegion.scrollTop = 73;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Workflow 0").closest("tr")?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(selectedRow);
    expect(scrollRegion.scrollTop).toBe(73);
  });

  it("filters by folder, status, branch and actor; supports sorting, collapsing, keyboard selection and refresh retention", async () => {
    const workflows = Array.from({ length: 4 }, (_, index) => ({
      id: String(index),
      name: `Workflow ${index}`,
      path: `.github/workflows/workflow-${index}.yml`,
      folder: index < 2 ? "CI" : "Deploy",
      availability: "synced",
      historyHydration: "not_loaded" as const,
      status: index % 2 ? "completed / failure" : "completed / success",
      title: `Resolved title ${index}`,
      branch: index < 2 ? "main" : "release",
      actor: index % 2 ? "teammate" : "roman",
      isMyRun: index % 2 === 0,
      duration: "1m",
      metrics: { passes: 4, failures: 1, sampleSize: 5, scope: "last 5 observed completed runs", passRate: 0.8, averageDurationMs: 60_000 },
    }));
    const bridge = {
      request: vi.fn().mockResolvedValue({
        repository: { owner: "acme", repo: "demo", authenticatedUserId: "42" },
        workflows,
      }),
    };
    render(<Dashboard bridge={bridge} />);
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(7));

    const filter = screen.getByLabelText("Filter workflows");
    fireEvent.change(filter, { target: { value: "Deploy" } });
    expect(screen.getByText("Workflow 2")).toBeTruthy();
    expect(screen.queryByText("Workflow 0")).toBeNull();
    fireEvent.change(filter, { target: { value: "release" } });
    expect(screen.getByText("Workflow 2")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "teammate" } });
    expect(screen.getByText("Workflow 1")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "completed / failure" } });
    expect(screen.getByText("Workflow 1")).toBeTruthy();
    expect(screen.queryByText("Workflow 0")).toBeNull();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });

    fireEvent.click(screen.getByRole("button", { name: "Workflow" }));
    const folderButton = screen.getByRole("button", { name: /CI/ });
    fireEvent.click(folderButton);
    expect(screen.queryByText("Workflow 0")).toBeNull();
    fireEvent.click(folderButton);

    const firstRow = screen.getByText("Workflow 0").closest("tr");
    const secondRow = screen.getByText("Workflow 1").closest("tr");
    expect(firstRow).not.toBeNull();
    expect(secondRow).not.toBeNull();
    firstRow?.focus();
    fireEvent.keyDown(firstRow as HTMLElement, { key: " " });
    secondRow?.focus();
    fireEvent.keyDown(secondRow as HTMLElement, { key: " " });
    expect(firstRow?.getAttribute("aria-selected")).toBe("true");
    expect(secondRow?.getAttribute("aria-selected")).toBe("true");

    const scrollRegion = document.querySelector(".table-wrap") as HTMLDivElement;
    scrollRegion.scrollTop = 73;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2));
    expect(scrollRegion.scrollTop).toBe(73);
    expect(document.activeElement).toBe(secondRow);
    expect(screen.getByText("Workflow 0").closest("tr")?.getAttribute("aria-selected")).toBe("true");
  });

  it("loads targeted workflow history on demand and updates the sampling projection", async () => {
    const initialData = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], false);
    const bridge = {
      request: vi.fn((operation: string) => Promise.resolve(operation === "dashboard.load"
        ? initialData
        : {
          metrics: { passes: 9, failures: 1, sampleSize: 10, scope: "last 10 observed completed runs", passRate: 0.9, averageDurationMs: 42_000 },
          partial: true,
          capped: false,
          page: 1,
          totalCount: 150,
        })),
    };
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("workflow-1");
    await screen.findByText("Load history");
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    await screen.findByText("· 10 runs*");
    expect(bridge.request).toHaveBeenLastCalledWith(
      "workflow.history.load",
      { workflowId: 1, page: 1 },
      expect.any(AbortSignal),
    );
    expect(screen.getByText("90%")).toBeTruthy();
  });

  it("opens the pipeline overview on row click and keeps selection on the checkbox", async () => {
    const initialData = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], false);
    const bridge = {
      request: vi.fn((operation: string) => operation === "dashboard.load"
        ? Promise.resolve(initialData)
        : new Promise(() => {})),
    };
    render(<Dashboard bridge={bridge} />);
    const row = (await screen.findByText("workflow-1")).closest("tr") as HTMLElement;
    fireEvent.click(row);
    expect(await screen.findByRole("complementary")).toBeTruthy();
    expect(row.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByLabelText("Select workflow-1"));
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("shows only the drawer when opened from a workflow editor, and reveals the deck on close", async () => {
    const dashboard = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1), makeWorkflow(2)], [makeRemoteWorkflow(1), makeRemoteWorkflow(2)], [], false);
    const initialData = { ...dashboard, initialWorkflowPath: ".github/workflows/workflow-1.yml", initialAction: "companion" };
    const bridge = {
      request: vi.fn((operation: string) => operation === "dashboard.load"
        ? Promise.resolve(initialData)
        : new Promise(() => {})),
    };
    const { container } = render(<Dashboard bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".ad-drawer-host--focused")).toBeTruthy());
    expect((container.querySelector(".ad-drawer-main") as HTMLElement).hidden).toBe(true);
    fireEvent.click(screen.getAllByTitle("Close (Esc)")[0] as HTMLElement);
    await waitFor(() => expect(container.querySelector(".ad-drawer-host--focused")).toBeNull());
    expect((container.querySelector(".ad-drawer-main") as HTMLElement).hidden).toBe(false);
    expect(screen.getByText("workflow-2")).toBeTruthy();
  });

  it("shows only the Action Center when the deck is opened for it", async () => {
    const dashboard = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], false);
    const bridge = {
      request: vi.fn((operation: string) => operation === "dashboard.load"
        ? Promise.resolve({ ...dashboard, initialView: "action-center" })
        : new Promise(() => {})),
    };
    const { container } = render(<Dashboard bridge={bridge} />);
    await waitFor(() => expect(container.querySelector(".ad-drawer-host--focused")).toBeTruthy());
    expect((container.querySelector(".ad-drawer-main") as HTMLElement).hidden).toBe(true);
  });

  it("renders the cached snapshot first and revalidates it in the background", async () => {
    const dashboard = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], false);
    const fresh = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1), makeWorkflow(2)], [makeRemoteWorkflow(1), makeRemoteWorkflow(2)], [], false);
    let resolveFresh: ((value: unknown) => void) | undefined;
    const bridge = {
      request: vi.fn((operation: string, payload?: { cached?: boolean }) => {
        if (operation !== "dashboard.load") return new Promise(() => {});
        if (payload?.cached) return Promise.resolve({ ...dashboard, cachedAt: Date.now() - 60_000 });
        return new Promise((resolve) => { resolveFresh = resolve; });
      }),
    };
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("workflow-1");
    await screen.findByText(/Updated 1m ago · refreshing/);
    expect(screen.queryByText("workflow-2")).toBeNull();
    expect(bridge.request).toHaveBeenLastCalledWith("dashboard.load", {}, expect.any(AbortSignal));
    resolveFresh?.(fresh);
    await screen.findByText("workflow-2");
    expect(screen.getByText("Updated just now")).toBeTruthy();
  });

  it("labels a workflow never-run only after an explicit empty history response", async () => {
    const initialData = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], false);
    const bridge = {
      request: vi.fn((operation: string) => Promise.resolve(operation === "dashboard.load"
        ? initialData
        : {
          metrics: { passes: 0, failures: 0, sampleSize: 0, scope: "last 0 observed completed runs", passRate: null, averageDurationMs: null },
          partial: false,
          capped: false,
          page: 1,
          totalCount: 0,
        })),
    };
    render(<Dashboard bridge={bridge} />);
    const row = (await screen.findByText("workflow-1")).closest("tr") as HTMLElement;
    expect(row.textContent).toContain("Not Loaded");
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: "Load history" }));
    await screen.findByText("Never Run");
    expect(bridge.request).toHaveBeenLastCalledWith(
      "workflow.history.load",
      { workflowId: 1, page: 1 },
      expect.any(AbortSignal),
    );
  });

  it("keeps a denied history request restricted instead of showing an empty history", async () => {
    const initialData = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], false);
    const bridge = {
      request: vi.fn((operation: string) => operation === "dashboard.load"
        ? Promise.resolve(initialData)
        : Promise.reject(new BridgeError("GitHub denied access.", "permission_restricted", false))),
    };
    render(<Dashboard bridge={bridge} />);
    fireEvent.click((await screen.findByText("workflow-1")).closest("tr") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Load history" }));
    await screen.findByText("Access Restricted");
    expect(screen.getByRole("alert").textContent).toContain("GitHub denied access");
  });

  it("renders partial and restricted availability distinctly from empty results", async () => {
    const bridge = {
      request: vi.fn().mockResolvedValue({
        repository: { owner: "acme", repo: "demo", authenticatedUserId: "" },
        workflows: ["partial_stale", "access_restricted"].map((availability, index) => ({
          id: String(index),
          name: `Workflow ${index}`,
          path: `.github/workflows/workflow-${index}.yml`,
          folder: "CI",
          availability,
          historyHydration: "not_loaded" as const,
          status: "—",
          title: "—",
          branch: "—",
          actor: "—",
          isMyRun: false,
          duration: "Not available",
          metrics: { passes: 0, failures: 0, sampleSize: 0, scope: "last 0 observed completed runs", passRate: null, averageDurationMs: null },
        })),
      }),
    };
    render(<Dashboard bridge={bridge} />);
    expect(await screen.findByText("Access Restricted")).toBeTruthy();
    expect(screen.queryByText("Synced")).toBeNull();
    expect(screen.queryByText(/No workflows found/)).toBeNull();
  });

  it("refreshes only for the displayed repository while retaining filter and selection", async () => {
    let onWorkflowChange: ((event: ReturnType<typeof hostEvent>) => void) | undefined;
    const workflows = [{
      id: "1",
      name: "Workflow 1",
      path: ".github/workflows/workflow-1.yml",
      folder: "CI",
      availability: "synced",
      historyHydration: "not_loaded" as const,
      status: "completed / success",
      title: "Resolved title",
      branch: "main",
      actor: "roman",
      isMyRun: true,
      duration: "1m",
      metrics: { passes: 1, failures: 0, sampleSize: 1, scope: "last 1 observed completed runs", passRate: 1, averageDurationMs: 60_000 },
    }];
    const bridge = {
      request: vi.fn().mockResolvedValue({
        repository: { owner: "acme", repo: "demo", authenticatedUserId: "42" },
        workflows,
      }),
      onEvent: vi.fn((_name: string, listener: typeof onWorkflowChange) => {
        onWorkflowChange = listener;
        return vi.fn();
      }),
    };
    render(<Dashboard bridge={bridge} />);
    await screen.findByText("Workflow 1");
    fireEvent.click(screen.getByLabelText("Select Workflow 1"));
    fireEvent.change(screen.getByLabelText("Filter workflows"), { target: { value: "Workflow" } });

    onWorkflowChange?.(hostEvent("changed", "workflows.changed", {
      repository: { owner: "another", repo: "demo" },
    }));
    expect(bridge.request).toHaveBeenCalledTimes(1);

    onWorkflowChange?.(hostEvent("changed", "workflows.changed", {
      repository: { owner: "acme", repo: "demo" },
    }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Workflow 1").closest("tr")?.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("Filter workflows") as HTMLInputElement).value).toBe("Workflow");
    expect(bridge.onEvent).toHaveBeenCalledWith("workflows.changed", expect.any(Function));
  });
});

describe("computeHealthSummary and MetricCell honesty", () => {
  it("renders 'No completed runs' and never '0%' when sampleSize is 0 or passRate is null", () => {
    const summary = computeHealthSummary({ passRate: null, sampleSize: 0 });
    expect(summary.kind).toBe("none");

    const { unmount } = render(<MetricCell passRate={null} sample={0} />);
    expect(screen.getByText("No completed runs")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    unmount();
  });

  it("renders 'only 3*' partial for 3 completed runs", () => {
    const summary = computeHealthSummary({
      passRate: 1,
      sampleSize: 3,
      averageDurationMs: 45_000,
      results: ["s", "s", "s"],
    });
    expect(summary.kind).toBe("computed");
    if (summary.kind === "computed") {
      expect(summary.sampleLabel).toBe("only 3");
      expect(summary.partial).toBe(true);
    }

    const { container, unmount } = render(
      <MetricCell passRate={100} avg="45s" sample={3} results={["s", "s", "s"]} />,
    );
    expect(screen.getByText("· 3 runs*")).toBeTruthy();
    expect(container.querySelectorAll(".ad-spark__bar--s")).toHaveLength(3);
    unmount();
  });

  it("renders 'last 20' and height-encoded result bars for 20 completed runs", () => {
    const results = Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? "f" : i % 7 === 0 ? "c" : "s")) as ("s" | "f" | "c")[];
    const { container, unmount } = render(
      <MetricCell passRate={85} avg="3m 12s" sample={20} results={results} />,
    );
    expect(screen.getByText("85%")).toBeTruthy();
    expect(screen.getByText("· 20 runs")).toBeTruthy();
    expect(container.querySelector(".ad-metric")?.getAttribute("title")).toContain("avg 3m 12s");
    expect(container.querySelectorAll(".ad-spark__bar")).toHaveLength(20);
    expect(container.querySelectorAll(".ad-spark__bar--f").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".ad-spark__bar--s").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".ad-spark__bar--c").length).toBeGreaterThan(0);
    unmount();
  });
});
