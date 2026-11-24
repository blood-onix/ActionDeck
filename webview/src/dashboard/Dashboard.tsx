import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BridgeError, getWebviewState, setWebviewState, type Bridge, type PersistedWebviewUiState } from "../bridge";
import { Toolbar } from "../components/Toolbar";
import { WorkflowTable, deckSignals, type NotificationMode, type SortKey, type WorkflowTableRowData } from "../components/WorkflowTable";
import { Drawer } from "../components/Drawer";
import { StateNotice } from "../components/StateNotice";
import { Button } from "../components/Button";
import { StatusLabel } from "../components/StatusLabel";
import { Icon } from "../components/Icon";
import { normalizeStatus } from "../utils/status";
import { mapErrorToDataState } from "../utils/data-state";
import { RunInspector } from "../inspector/RunInspector";
import { Companion } from "../companion/Companion";
import { PipelineOverview } from "../pipeline/PipelineOverview";
import { BatchForm } from "./BatchForm";
import { ReleasePlanEditor } from "./ReleasePlanEditor";
import { ReleasePlanProgress } from "./ReleasePlanProgress";
import { ActionCenter } from "./ActionCenter";
import type { AutoApprovalRule } from "../../../src/domain/models/approval";
import { ApprovalRules, type ApprovalAuditView } from "./ApprovalRules";
import { SettingsInspector } from "./SettingsInspector";
import type { ReleasePlan } from "../../../src/domain/models/release-plan";
import { formatRelativeTime } from "../../../src/domain/services/relative-time";
import { formatDurationMs } from "../utils/health-metrics";
import { GroupPicker } from "./GroupPicker";
import { ColumnsMenu } from "./ColumnsMenu";
import { normalizeColumnLayout, type ColumnLayout } from "../utils/columns";

type WorkflowRow = WorkflowTableRowData;

interface DashboardData {
  repository: { owner: string; repo: string; authenticatedUserId: string };
  workflows: WorkflowRow[];
  warning?: string;
  warningKind?: "stale" | "sso";
  initialWorkflowPath?: string;
  initialAction?: "companion" | "latest-run" | "pipeline";
  initialRunId?: number;
  initialView?: "action-center";
  /** Present when the host answered from its cache; the view then revalidates in the background. */
  cachedAt?: number;
  plans?: ReleasePlan[];
  approvalRules?: AutoApprovalRule[];
  approvalAudit?: ApprovalAuditView[];
  customGroups?: string[];
  columnLayout?: ColumnLayout;
  runRefreshSeconds?: number;
}

interface WorkflowHistoryResult {
  metrics: WorkflowRow["metrics"];
  partial: boolean;
  capped: boolean;
  page: number;
  totalCount: number;
}

type DrawerPayload =
  | {
      readonly kind: "inspector";
      readonly runId: number;
      readonly workflowId?: number;
      readonly workflowName?: string;
      readonly workflowPath?: string;
      readonly refName?: string;
      readonly autoAction?: "explain" | "investigate";
      /** Drawer to go back to when this run is closed, e.g. the pipeline it was opened from. */
      readonly returnTo?: DrawerPayload;
    }
  | {
      readonly kind: "pipeline";
      readonly workflowId?: number;
      readonly workflowPath: string;
      readonly workflowName: string;
      readonly latestRunId?: number;
      readonly latestRunStatus?: string;
      readonly defaultBranch?: string;
    }
  | {
      readonly kind: "companion";
      readonly workflowId?: number;
      readonly workflowPath: string;
      readonly workflowName: string;
      readonly availability: string;
      readonly latestRunId?: number;
      readonly latestRunStatus?: string;
      readonly initialRef?: string;
      readonly initialInputs?: ReadonlyArray<{ name: string; value: string }>;
      readonly returnTo?: DrawerPayload;
    }
  | {
      readonly kind: "batch";
      readonly workflowIds: readonly string[];
    }
  | {
      readonly kind: "plan_editor";
      readonly workflowIds: readonly string[];
      /** Set when editing a saved plan that has not started. */
      readonly planId?: string;
    }
  | {
      readonly kind: "action_center";
    }
  | {
      readonly kind: "settings";
    };

interface DrawerState {
  active: DrawerPayload | null;
  openerRowId: string | null;
  openerElement: HTMLElement | null;
  widthPx: number;
  dockedPosition: "side" | "bottom";
}

function activeDeckStatus(row: WorkflowRow) {
  const status = normalizeStatus(row.status);
  return status === "running" || status === "queued" || status === "waiting_approval" ? status : null;
}

function RunningSummary({
  rows,
  onInspect,
  onOpenWorkflow,
}: {
  rows: readonly WorkflowRow[];
  onInspect: (row: WorkflowRow) => void;
  onOpenWorkflow: (row: WorkflowRow) => void;
}) {
  const activeRows = rows.filter((row) => activeDeckStatus(row) !== null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasKnownElapsed = activeRows.some((row) =>
    activeDeckStatus(row) === "running" && Boolean(row.latestRun?.runStartedAt),
  );

  useEffect(() => {
    if (!hasKnownElapsed) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasKnownElapsed]);

  const running = activeRows.filter((row) => activeDeckStatus(row) === "running").length;
  const queued = activeRows.filter((row) => activeDeckStatus(row) === "queued").length;
  const waiting = activeRows.filter((row) => activeDeckStatus(row) === "waiting_approval").length;

  const failing = rows.filter((row) => normalizeStatus(row.status) === "failure").length;
  const slower = rows.filter((row) => deckSignals(row).some((signal) => signal.kind === "slowdown")).length;
  const healthy = rows.filter((row) => normalizeStatus(row.status) === "success").length - slower;

  return (
    <section className="ad-running-summary" aria-label="Run activity summary">
      <div className="ad-running-summary__counts">
        {running > 0 ? (
          <span className="ad-running-summary__count ad-running-summary__count--running">
            <Icon name="sync" size={14} spin />
            <strong>{running} running</strong>
          </span>
        ) : (
          <span className="ad-running-summary__count">
            <Icon name="circle-large-outline" size={14} />
            <span>No runs running</span>
          </span>
        )}
        {queued > 0 ? <span className="ad-running-summary__count">{queued} queued</span> : null}
        {waiting > 0 ? (
          <span className="ad-running-summary__count ad-running-summary__count--warning">
            <Icon name="person" size={14} />
            {waiting} waiting for approval
          </span>
        ) : null}
        {failing > 0 ? (
          <span className="ad-running-summary__count ad-running-summary__count--failure">
            <Icon name="error" size={14} />
            {failing} failing
          </span>
        ) : null}
        {slower > 0 ? (
          <span className="ad-running-summary__count ad-running-summary__count--warning">
            <Icon name="watch" size={14} />
            {slower} slower than usual
          </span>
        ) : null}
        {healthy > 0 ? (
          <span className="ad-running-summary__count ad-running-summary__count--muted">
            <Icon name="pass" size={14} />
            {healthy} healthy
          </span>
        ) : null}
      </div>
      {activeRows.length > 0 ? (
        <div className="ad-running-summary__jobs" aria-label="Active runs">
          {activeRows.map((row) => {
            const status = activeDeckStatus(row)!;
            const title = row.latestRun?.displayTitle ?? (row.title !== "—" ? row.title : undefined);
            const startedAt = status === "running" ? row.latestRun?.runStartedAt : undefined;
            const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
            const elapsed = Number.isFinite(startedMs)
              ? formatDurationMs(Math.max(0, nowMs - startedMs))
              : undefined;
            return (
              <button
                type="button"
                className="ad-running-summary__job"
                key={row.id}
                onClick={() => row.latestRunId === undefined ? onOpenWorkflow(row) : onInspect(row)}
                title={row.latestRunId === undefined ? `Open ${row.name}` : `Inspect latest run #${row.latestRunId}`}
              >
                <StatusLabel status={status} still />
                <span className="ad-running-summary__name">{row.name}</span>
                {title ? <span className="ad-running-summary__title">{title}</span> : null}
                {row.latestRunId !== undefined ? (
                  <span className="ad-mono-sm ad-running-summary__id">#{row.latestRunId}</span>
                ) : null}
                {elapsed ? <span className="ad-num">{elapsed}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function pipelinePayload(row: WorkflowRow): DrawerPayload {
  return {
    kind: "pipeline",
    ...(row.workflowId !== undefined ? { workflowId: row.workflowId } : {}),
    workflowPath: row.path,
    workflowName: row.name,
    ...(row.latestRunId !== undefined ? { latestRunId: row.latestRunId } : {}),
    latestRunStatus: row.status,
    ...(row.branch && row.branch !== "—" ? { defaultBranch: row.branch } : {}),
  };
}

export function Dashboard({ bridge }: { bridge: Bridge }) {
  const [data, setData] = useState<DashboardData>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [myRunsOnly, setMyRunsOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("folder");
  const [sortDirection, setSortDirection] = useState<1 | -1>(1);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [plans, setPlans] = useState<ReleasePlan[]>([]);
  /** Plans that finished while this view was open; they stay visible until dismissed so the outcome is seen. */
  const [finishedPlanIds, setFinishedPlanIds] = useState<string[]>([]);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [historyLoadingIds, setHistoryLoadingIds] = useState<number[]>([]);
  const [panelWidth, setPanelWidth] = useState(1000);
  const [columnLayout, setColumnLayout] = useState<ColumnLayout>(() => normalizeColumnLayout(undefined));
  const [popover, setPopover] = useState<"group" | "columns" | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState("");
  const saveColumnsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [drawer, setDrawer] = useState<DrawerState>(() => ({
    active: null,
    openerRowId: null,
    openerElement: null,
    widthPx: Math.max(360, getWebviewState<PersistedWebviewUiState>().drawerWidthPx ?? 480),
    dockedPosition: "side",
  }));
  // Direct entry points (Open companion, Open latest run, Action Center, notification run links) show only the drawer surface; closing it reveals the full deck.
  const [focusDismissed, setFocusDismissed] = useState(false);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  const mainRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const loadController = useRef<AbortController | undefined>(undefined);
  const historyRequests = useRef(new Map<number, AbortController>());
  const openedWorkflowRequest = useRef<string | undefined>(undefined);
  const openedInitialView = useRef(false);
  const tableWrap = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<{ top: number; left: number; rowId?: string } | undefined>(undefined);

  useEffect(() => {
    const el = mainRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.round(entry.contentRect.width);
        if (width > 0) {
          setPanelWidth(width);
          setDrawer((current) => {
            const nextDocked = width < 700 ? "bottom" : "side";
            return current.dockedPosition === nextDocked
              ? current
              : { ...current, dockedPosition: nextDocked };
          });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function load({ preferCached = false }: { preferCached?: boolean } = {}) {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setError("");
    setErrorCode(undefined);
    setRefreshing(true);
    try {
      const loaded = await bridge.request<DashboardData>(
        "dashboard.load",
        preferCached ? { cached: true } : {},
        controller.signal,
      );
      const wrap = tableWrap.current;
      if (wrap) {
        const focused =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.closest<HTMLElement>("[data-row-id]")
            : null;
        pendingRestore.current = {
          top: wrap.scrollTop,
          left: wrap.scrollLeft,
          ...(focused?.dataset.rowId ? { rowId: focused.dataset.rowId } : {}),
        };
      }
      setData(loaded);
      setPlans(loaded.plans ?? []);
      if (loaded.columnLayout && saveColumnsTimer.current === undefined) {
        setColumnLayout(normalizeColumnLayout(loaded.columnLayout));
      }
      if (loaded.cachedAt !== undefined) {
        // Show the cached snapshot right away, then fetch what changed since.
        setLastUpdated(`Updated ${formatRelativeTime(loaded.cachedAt) ?? "recently"} · refreshing…`);
        void load();
        return;
      }
      setLastUpdated("Updated just now");
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (reason instanceof BridgeError) {
          setErrorCode(reason.code);
        }
      }
    } finally {
      if (loadController.current === controller) {
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void load({ preferCached: true });
    return () => loadController.current?.abort();
  }, []);

  useLayoutEffect(() => {
    const restore = pendingRestore.current;
    const wrap = tableWrap.current;
    if (!restore || !wrap) return;
    pendingRestore.current = undefined;
    wrap.scrollTop = restore.top;
    wrap.scrollLeft = restore.left;
    if (restore.rowId) {
      const row = [...wrap.querySelectorAll<HTMLElement>("[data-row-id]")].find(
        (item) => item.dataset.rowId === restore.rowId,
      );
      if (row && document.activeElement !== row) row.focus({ preventScroll: true });
    }
  }, [data]);

  const activeCompanionPath =
    drawer.active?.kind === "companion" ? drawer.active.workflowPath : undefined;

  useEffect(() => bridge.onEvent?.("workflows.changed", (event) => {
    const repository = event.payload.repository;
    if (
      data &&
      typeof repository === "object" &&
      repository !== null &&
      "owner" in repository &&
      "repo" in repository &&
      repository.owner === data.repository.owner &&
      repository.repo === data.repository.repo
    ) {
      void load();
    }
  }), [bridge, data?.repository.owner, data?.repository.repo]);

  useEffect(() => bridge.onEvent?.("workflow.preview.changed", (event) => {
    if (
      activeCompanionPath &&
      typeof event.payload === "object" &&
      event.payload !== null &&
      event.payload.workflowPath === activeCompanionPath
    ) {
      setPreviewRefreshKey((current) => current + 1);
    }
  }), [bridge, activeCompanionPath]);

  useEffect(() => bridge.onEvent?.("repository.session.changed", (event) => {
    const repository = event.payload.repository;
    if (
      data &&
      typeof repository === "object" &&
      repository !== null &&
      "owner" in repository &&
      "repo" in repository &&
      repository.owner === data.repository.owner &&
      repository.repo === data.repository.repo
    ) {
      setPreviewRefreshKey((current) => current + 1);
      void load();
    }
  }), [bridge, data?.repository.owner, data?.repository.repo]);

  useEffect(() => bridge.onEvent?.("plan.updated", (event) => {
    const plan = event.payload.plan as ReleasePlan | undefined;
    if (plan && typeof plan === "object" && typeof plan.id === "string") {
      if (plan.state === "completed") {
        setFinishedPlanIds((current) => (current.includes(plan.id) ? current : [...current, plan.id]));
      }
      setPlans((current) => [...current.filter((item) => item.id !== plan.id), plan]);
    }
  }), [bridge]);

  useEffect(() => bridge.onEvent?.("runs.observed", (event) => {
    const repository = event.payload.repository;
    const patches = event.payload.runs;
    if (
      !Array.isArray(patches) ||
      typeof repository !== "object" ||
      repository === null ||
      !("owner" in repository) ||
      !("repo" in repository)
    ) return;
    setData((current) => {
      if (!current || repository.owner !== current.repository.owner || repository.repo !== current.repository.repo) {
        return current;
      }
      const byWorkflow = new Map<number, LatestRunPatch>();
      for (const patch of patches as LatestRunPatch[]) {
        if (typeof patch?.workflowId === "number") byWorkflow.set(patch.workflowId, patch);
      }
      let changed = false;
      const workflows = current.workflows.map((row) => {
        const patch = row.workflowId === undefined ? undefined : byWorkflow.get(row.workflowId);
        if (!patch || !isNewerRun(row, patch)) return row;
        changed = true;
        const { workflowId: _workflowId, ...fields } = patch;
        return {
          ...row,
          ...fields,
          availability: row.availability === "run_info_not_loaded" ? "synced" : row.availability,
        };
      });
      return changed ? { ...current, workflows } : current;
    });
  }), [bridge]);

  const openDrawer = useCallback((payload: DrawerPayload, openerRowId: string | null = null) => {
    const openerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawer((current) => ({
      ...current,
      active: payload,
      openerRowId,
      openerElement,
    }));
  }, []);

  const closeDrawer = useCallback(() => {
    const active = drawerRef.current.active;
    if ((active?.kind === "inspector" || active?.kind === "companion") && active.returnTo) {
      const returnTo = active.returnTo;
      setDrawer((current) => ({ ...current, active: returnTo }));
      return;
    }
    setDrawer((current) => {
      const { openerRowId, openerElement } = current;
      queueMicrotask(() => {
        const wrap = tableWrap.current;
        if (openerRowId && wrap) {
          const allRows = [...wrap.querySelectorAll<HTMLElement>("tr[data-row-id]")];
          const exact = allRows.find((el) => el.dataset.rowId === openerRowId);
          if (exact) {
            exact.focus({ preventScroll: true });
            return;
          }
          const fallbackRow = allRows[0];
          if (fallbackRow) {
            fallbackRow.focus({ preventScroll: true });
            return;
          }
          const grid = wrap.querySelector<HTMLElement>('table[role="treegrid"]');
          if (grid) {
            grid.focus({ preventScroll: true });
            return;
          }
        }
        openerElement?.focus({ preventScroll: true });
      });
      return { ...current, active: null, openerRowId: null, openerElement: null };
    });
    setFocusDismissed(true);
  }, []);

  const handleDrawerWidthChange = useCallback((widthPx: number) => {
    const clamped = Math.max(360, Math.round(widthPx));
    setWebviewState<PersistedWebviewUiState>({ drawerWidthPx: clamped });
    setDrawer((current) => ({ ...current, widthPx: clamped }));
  }, []);

  useEffect(() => {
    if (data?.initialView === "action-center" && !openedInitialView.current) {
      openedInitialView.current = true;
      openDrawer({ kind: "action_center" });
    }
    if (data?.initialRunId) {
      const requestKey = `run:${data.initialRunId}`;
      if (openedWorkflowRequest.current !== requestKey) {
        openDrawer({ kind: "inspector", runId: data.initialRunId });
        openedWorkflowRequest.current = requestKey;
      }
      return;
    }
    if (!data?.initialWorkflowPath || !data.initialAction) return;
    const requestKey = `${data.initialWorkflowPath}:${data.initialAction}`;
    if (openedWorkflowRequest.current === requestKey) return;
    const row = data.workflows.find(
      (workflow) => workflow.path.replace(/^\/+/, "").toLowerCase() === data.initialWorkflowPath?.toLowerCase(),
    );
    if (!row) {
      setError("The workflow is not present in the selected repository inventory.");
    } else if (data.initialAction === "pipeline") {
      openDrawer(pipelinePayload(row), row.id);
    } else if (data.initialAction === "latest-run") {
      if (row.latestRunId === undefined) setError("No recent run is available for this workflow.");
      else {
        openDrawer(
          {
            kind: "inspector",
            runId: row.latestRunId,
            ...(row.workflowId !== undefined ? { workflowId: row.workflowId } : {}),
            workflowName: row.name,
            workflowPath: row.path,
            ...(row.branch && row.branch !== "—" ? { refName: row.branch } : {}),
          },
          row.id,
        );
      }
    } else {
      openDrawer(
        {
          kind: "companion",
          ...(row.workflowId !== undefined ? { workflowId: row.workflowId } : {}),
          workflowPath: row.path,
          workflowName: row.name,
          availability: row.availability,
          ...(row.latestRunId !== undefined ? { latestRunId: row.latestRunId } : {}),
          latestRunStatus: row.status,
        },
        row.id,
      );
    }
    openedWorkflowRequest.current = requestKey;
  }, [data, openDrawer]);

  useEffect(() => () => {
    for (const controller of historyRequests.current.values()) controller.abort();
    historyRequests.current.clear();
  }, []);

  const loadHistory = useCallback(async (row: WorkflowRow) => {
    const workflowId = row.workflowId;
    if (workflowId === undefined) return;
    historyRequests.current.get(workflowId)?.abort();
    const controller = new AbortController();
    historyRequests.current.set(workflowId, controller);
    setHistoryLoadingIds((current) => [...current.filter((id) => id !== workflowId), workflowId]);
    setError("");
    try {
      const history = await bridge.request<WorkflowHistoryResult>(
        "workflow.history.load",
        { workflowId, page: row.historyPartial ? (row.historyPage ?? 0) + 1 : 1 },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setData((current) => current && ({
        ...current,
        workflows: current.workflows.map((candidate) =>
          candidate.workflowId === workflowId
            ? {
                ...candidate,
                metrics: history.metrics,
                historyHydration: history.partial ? "partial" : "loaded",
                availability:
                  candidate.availability === "run_info_not_loaded"
                    ? history.totalCount === 0
                      ? "never_run"
                      : "synced"
                    : candidate.availability,
                historyPartial: history.partial,
                historyCapped: history.capped,
                historyPage: history.page,
              }
            : candidate,
        ),
      }));
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (reason instanceof BridgeError) {
          setData((current) => current && ({
            ...current,
            workflows: current.workflows.map((candidate) =>
              candidate.workflowId === workflowId
                ? {
                    ...candidate,
                    historyHydration: isRestrictedHistoryCode(reason.code) ? "restricted" : "partial",
                    ...(isRestrictedHistoryCode(reason.code) ? { availability: "access_restricted" } : {}),
                  }
                : candidate,
            ),
          }));
        }
      }
    } finally {
      if (historyRequests.current.get(workflowId) === controller) {
        historyRequests.current.delete(workflowId);
        setHistoryLoadingIds((current) => current.filter((id) => id !== workflowId));
      }
    }
  }, [bridge]);

  // Pre-indexed lowercase search haystacks for <100ms 100-row filtering
  const indexedWorkflows = useMemo(
    () =>
      (data?.workflows ?? []).map((row) => ({
        row,
        haystack: `${row.name} ${row.path} ${row.folder} ${row.branch} ${row.actor} ${row.status} ${row.title}`.toLowerCase(),
      })),
    [data?.workflows],
  );

  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return indexedWorkflows
      .filter(({ row, haystack }) => {
        if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
        if (status !== "all" && row.availability !== status && row.status !== status) return false;
        if (myRunsOnly && !row.isMyRun) return false;
        return true;
      })
      .map(({ row }) => row)
      .sort((left, right) => compareRows(left, right, sortKey) * sortDirection);
  }, [indexedWorkflows, query, status, myRunsOnly, sortKey, sortDirection]);

  const groupedRows = useMemo(() => {
    const groups = new Map<string, WorkflowRow[]>();
    for (const row of rows) {
      const list = groups.get(row.folder);
      if (list) list.push(row);
      else groups.set(row.folder, [row]);
    }
    // Named groups first; the Ungrouped fallback always comes last.
    const entries = [...groups.entries()];
    return [
      ...entries.filter(([folder]) => folder !== UNGROUPED),
      ...entries.filter(([folder]) => folder === UNGROUPED),
    ];
  }, [rows]);

  const existingGroups = useMemo(
    () =>
      [...new Set([...(data?.workflows ?? []).map((row) => row.folder), ...(data?.customGroups ?? [])])]
        .filter((folder) => folder !== UNGROUPED)
        .sort((left, right) => left.localeCompare(right)),
    [data?.workflows, data?.customGroups],
  );

  const changeColumnLayout = useCallback((layout: ColumnLayout) => {
    setColumnLayout(layout);
    if (saveColumnsTimer.current !== undefined) clearTimeout(saveColumnsTimer.current);
    saveColumnsTimer.current = setTimeout(() => {
      saveColumnsTimer.current = undefined;
      void bridge.request("dashboard.saveColumns", { layout }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 400);
  }, [bridge]);

  useEffect(() => () => {
    if (saveColumnsTimer.current !== undefined) clearTimeout(saveColumnsTimer.current);
  }, []);

  async function applyGroup(group: string | null) {
    const paths = (data?.workflows ?? []).filter((row) => selected.includes(row.id)).map((row) => row.path);
    if (paths.length === 0) return;
    setGroupBusy(true);
    setGroupError("");
    try {
      await bridge.request("workflow.setGroup", { workflowPaths: paths, group });
      if (group === null) {
        // The default group comes from file comments and prefix rules, which only the host knows.
        void load({ preferCached: true });
      } else {
        setData((current) => current && ({
          ...current,
          customGroups: [...new Set([...(current.customGroups ?? []), group])],
          workflows: current.workflows.map((row) => (paths.includes(row.path) ? { ...row, folder: group } : row)),
        }));
        setCollapsedFolders((current) => current.filter((folder) => folder !== group));
      }
      setSelected([]);
      setPopover(null);
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGroupBusy(false);
    }
  }

  const statusOptions = useMemo(
    () =>
      [...new Set((data?.workflows ?? []).flatMap((row) => [row.availability, row.status]))]
        .filter((value) => value !== "—")
        .sort(),
    [data?.workflows],
  );

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDirection((direction) => (direction === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDirection(1);
    }
  }

  function toggleFolder(folder: string) {
    setCollapsedFolders((previous) =>
      previous.includes(folder)
        ? previous.filter((item) => item !== folder)
        : [...previous, folder],
    );
  }

  const toggle = useCallback((id: string) => {
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  }, []);

  const inspectRow = useCallback(
    (row: WorkflowRow) => {
      if (row.latestRunId === undefined) return;
      openDrawer(
        {
          kind: "inspector",
          runId: row.latestRunId,
          ...(row.workflowId !== undefined ? { workflowId: row.workflowId } : {}),
          workflowName: row.name,
          workflowPath: row.path,
          ...(row.branch && row.branch !== "—" ? { refName: row.branch } : {}),
        },
        row.id,
      );
    },
    [openDrawer],
  );

  const inspectRunById = useCallback(
    (runId: number) => {
      const inspectedRow = data?.workflows.find((row) => row.latestRunId === runId);
      openDrawer(
        {
          kind: "inspector",
          runId,
          ...(inspectedRow?.workflowId !== undefined ? { workflowId: inspectedRow.workflowId } : {}),
          ...(inspectedRow?.name ? { workflowName: inspectedRow.name } : {}),
          ...(inspectedRow?.path ? { workflowPath: inspectedRow.path } : {}),
          ...(inspectedRow?.branch && inspectedRow.branch !== "—" ? { refName: inspectedRow.branch } : {}),
        },
        inspectedRow?.id ?? null,
      );
    },
    [data?.workflows, openDrawer],
  );

  const openPipeline = useCallback(
    (row: WorkflowRow) => openDrawer(pipelinePayload(row), row.id),
    [openDrawer],
  );

  const openInTab = useCallback(
    (target: { kind: "pipeline"; workflowPath: string } | { kind: "run"; runId: number }) => {
      bridge.request("view.openInTab", target).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "ActionDeck could not open a new tab.");
      });
    },
    [bridge],
  );

  const openPipelineInTab = useCallback(
    (row: WorkflowRow) => {
      // A double-click's first click already opened the side drawer; the tab replaces it.
      const active = drawerRef.current.active;
      if (active?.kind === "pipeline" && active.workflowPath === row.path) closeDrawer();
      openInTab({ kind: "pipeline", workflowPath: row.path.replace(/^\/+/, "") });
    },
    [closeDrawer, openInTab],
  );

  const openWorkflowByPath = useCallback(
    (workflowPath: string) => {
      const target = workflowPath.replace(/^\/+/, "").toLowerCase();
      const row = data?.workflows.find((candidate) => candidate.path.replace(/^\/+/, "").toLowerCase() === target);
      if (row) openDrawer(pipelinePayload(row), row.id);
    },
    [data?.workflows, openDrawer],
  );

  const openCompanion = useCallback(
    (row: WorkflowRow) => {
      if (row.workflowId === undefined) return;
      openDrawer(
        {
          kind: "companion",
          workflowId: row.workflowId,
          workflowPath: row.path,
          workflowName: row.name,
          availability: row.availability,
          ...(row.latestRunId !== undefined ? { latestRunId: row.latestRunId } : {}),
          latestRunStatus: row.status,
        },
        row.id,
      );
    },
    [openDrawer],
  );

  const changeNotificationMode = useCallback(
    async (row: WorkflowRow, mode: NotificationMode) => {
      if (row.workflowId === undefined) return;
      const previous = row.notificationMode ?? "my_runs_only";
      const apply = (value: NotificationMode) =>
        setData(
          (current) =>
            current && {
              ...current,
              workflows: current.workflows.map((candidate) =>
                candidate.id === row.id ? { ...candidate, notificationMode: value } : candidate,
              ),
            },
        );
      apply(mode);
      try {
        await bridge.request("subscription.update", { workflowId: row.workflowId, mode });
      } catch (reason) {
        apply(previous);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [bridge],
  );

  const ruleWorkflows = useMemo(
    () =>
      (data?.workflows ?? [])
        .filter((row) => row.workflowId !== undefined)
        .map((row) => ({ workflowId: row.workflowId!, name: row.name })),
    [data],
  );

  const pendingRuns = useMemo(
    () =>
      (data?.workflows ?? [])
        .filter((row) => row.status === "waiting" && row.latestRunId !== undefined)
        .map((row) => ({
          runId: row.latestRunId!,
          workflowName: row.name,
          ...(row.workflowId !== undefined ? { workflowId: row.workflowId } : {}),
          ...(row.branch && row.branch !== "—" ? { branch: row.branch } : {}),
        })),
    [data],
  );

  const upsertPlan = useCallback((updated: ReleasePlan) => {
    setPlans((current) => [...current.filter((plan) => plan.id !== updated.id), updated]);
  }, []);

  const selectedWorkflows = useMemo(
    () =>
      (data?.workflows ?? [])
        .filter((row) => selected.includes(row.id) && row.workflowId !== undefined)
        .map((row) => ({
          workflowId: row.workflowId!,
          name: row.name,
          path: row.path,
          ...(row.branch && row.branch !== "—" ? { defaultBranch: row.branch } : {}),
        })),
    [data?.workflows, selected],
  );

  const errorDataState = error
    ? mapErrorToDataState(errorCode, error, {
        ...(lastUpdated ? { lastUpdated } : {}),
        hasRetainedData: Boolean(data),
      })
    : null;

  const focusRequested = Boolean(
    data && ((data.initialWorkflowPath && data.initialAction) || data.initialRunId || data.initialView),
  );
  const focused = focusRequested && drawer.active !== null && !focusDismissed;

  function renderDrawer() {
    const active = drawer.active;
    if (!active) return null;

    if (active.kind === "settings") {
      return (
        <Drawer
          title="Repository Settings"
          subtitle={data ? `${data.repository.owner}/${data.repository.repo}` : undefined}
          widthPx={drawer.widthPx}
          dockedPosition={drawer.dockedPosition}
          onWidthChange={handleDrawerWidthChange}
          onClose={closeDrawer}
        >
          <SettingsInspector bridge={bridge} />
        </Drawer>
      );
    }

    if (active.kind === "action_center") {
      return (
        <Drawer
          title="Action Center"
          ariaLabel="Action Center"
          subtitle={`${pendingRuns.length} pending approvals`}
          widthPx={drawer.widthPx}
          dockedPosition={drawer.dockedPosition}
          onWidthChange={handleDrawerWidthChange}
          onClose={closeDrawer}
        >
          <ActionCenter
            bridge={bridge}
            pendingRunIds={pendingRuns.map((run) => run.runId)}
            pendingRuns={pendingRuns}
            queuedCount={(data?.workflows ?? []).filter((row) => row.status === "queued").length}
            approvalWaitCount={pendingRuns.length}
            plans={plans}
            onInspectRun={inspectRunById}
            onClose={closeDrawer}
          />
          <ApprovalRules
            bridge={bridge}
            {...(data?.approvalRules ? { initialRules: data.approvalRules } : {})}
            {...(data?.approvalAudit ? { audit: data.approvalAudit } : {})}
            workflows={ruleWorkflows}
          />
        </Drawer>
      );
    }

    if (active.kind === "plan_editor") {
      const editing = active.planId ? plans.find((plan) => plan.id === active.planId) : undefined;
      return (
        <Drawer
          title={editing ? `Edit plan · ${editing.name}` : `New plan (${selectedWorkflows.length})`}
          widthPx={drawer.widthPx}
          dockedPosition={drawer.dockedPosition}
          onWidthChange={handleDrawerWidthChange}
          onClose={closeDrawer}
        >
          <ReleasePlanEditor
            key={editing?.id ?? "new"}
            bridge={bridge}
            workflows={selectedWorkflows}
            {...(editing ? { plan: editing, heading: "Edit Release Plan" } : {})}
            onSaved={(saved) => {
              upsertPlan(saved);
              closeDrawer();
            }}
            onClose={closeDrawer}
          />
        </Drawer>
      );
    }

    if (active.kind === "batch") {
      return (
        <Drawer
          title={`Run selected (${selectedWorkflows.length})`}
          widthPx={drawer.widthPx}
          dockedPosition={drawer.dockedPosition}
          onWidthChange={handleDrawerWidthChange}
          onClose={closeDrawer}
        >
          <BatchForm
            bridge={bridge}
            workflows={selectedWorkflows}
            onClose={closeDrawer}
            onInspectRun={inspectRunById}
          />
        </Drawer>
      );
    }

    if (active.kind === "pipeline") {
      const pipelineRow = data?.workflows.find((row) => row.path === active.workflowPath);
      const latestRunAt = pipelineRow?.latestRunAt ? formatRelativeTime(pipelineRow.latestRunAt) : undefined;
      return (
        <Drawer
          title={active.workflowName}
          subtitle={
            <>
              <span className="ad-mono-sm">{active.workflowPath}</span>
              {active.latestRunStatus ? (
                <StatusLabel status={normalizeStatus(active.latestRunStatus)} className="ad-status--tinted" />
              ) : null}
              {latestRunAt ? <span>· {latestRunAt}</span> : null}
            </>
          }
          actions={
            <>
              {focused ? null : (
                <Button
                  variant="ghost"
                  icon="link-external"
                  title="Open in a tab"
                  aria-label="Open in a tab"
                  onClick={() => {
                    closeDrawer();
                    openInTab({ kind: "pipeline", workflowPath: active.workflowPath.replace(/^\/+/, "") });
                  }}
                />
              )}
              <Button
                variant="ghost"
                icon="go-to-file"
                title="Open workflow file"
                onClick={() => void bridge.request("workflow.openFile", { workflowPath: active.workflowPath }).catch(() => undefined)}
              />
            </>
          }
          widthPx={drawer.widthPx}
          dockedPosition={drawer.dockedPosition}
          onWidthChange={handleDrawerWidthChange}
          onClose={closeDrawer}
        >
          <PipelineOverview
            key={active.workflowPath}
            bridge={bridge}
            workflow={active}
            plans={plans}
            previewRefreshKey={previewRefreshKey}
            onInspectRun={(runId) => openDrawer({
              kind: "inspector",
              runId,
              ...(active.workflowId !== undefined ? { workflowId: active.workflowId } : {}),
              workflowName: active.workflowName,
              workflowPath: active.workflowPath,
              returnTo: active,
            }, drawer.openerRowId)}
            onPlanSaved={upsertPlan}
          />
        </Drawer>
      );
    }

    if (active.kind === "companion") {
      return (
        <Drawer
          title={active.workflowName}
          subtitle={
            <>
              <span className="ad-mono-sm">{active.workflowPath}</span>
              {active.latestRunStatus ? (
                <StatusLabel status={normalizeStatus(active.latestRunStatus)} />
              ) : null}
            </>
          }
          widthPx={drawer.widthPx}
          dockedPosition={drawer.dockedPosition}
          onWidthChange={handleDrawerWidthChange}
          onClose={closeDrawer}
        >
          <Companion
            bridge={bridge}
            {...(active.workflowId === undefined ? {} : { workflowId: active.workflowId })}
            workflowPath={active.workflowPath}
            workflowName={active.workflowName}
            {...(active.latestRunId === undefined ? {} : { latestRunId: active.latestRunId })}
            {...(active.latestRunStatus ? { latestRunStatus: active.latestRunStatus } : {})}
            previewRefreshKey={previewRefreshKey}
            {...(active.initialRef !== undefined ? { initialRef: active.initialRef } : {})}
            {...(active.initialInputs !== undefined ? { initialInputs: active.initialInputs } : {})}
            onInspectLatest={() => {
              if (active.latestRunId !== undefined) inspectRunById(active.latestRunId);
            }}
            onInspectRun={inspectRunById}
            onClose={closeDrawer}
          />
        </Drawer>
      );
    }

    return (
      <Drawer
        title={`${active.workflowName ? `${active.workflowName} · ` : ""}Run #${active.runId}`}
        actions={
          <>
            {active.returnTo ? (
              <Button variant="ghost" icon="arrow-left" title="Back to pipeline" onClick={closeDrawer}>
                Back
              </Button>
            ) : null}
            {data?.initialRunId === active.runId ? null : (
              <Button
                variant="ghost"
                icon="link-external"
                title="Open run in a tab"
                aria-label="Open run in a tab"
                onClick={() => openInTab({ kind: "run", runId: active.runId })}
              />
            )}
          </>
        }
        widthPx={drawer.widthPx}
        dockedPosition={drawer.dockedPosition}
        onWidthChange={handleDrawerWidthChange}
        onClose={closeDrawer}
      >
        <RunInspector
          bridge={bridge}
          runId={active.runId}
          {...(data?.runRefreshSeconds !== undefined ? { defaultRefreshSeconds: data.runRefreshSeconds } : {})}
          {...(active.workflowId !== undefined ? { workflowId: active.workflowId } : {})}
          {...(active.refName ? { refName: active.refName } : {})}
          {...(active.autoAction ? { autoAction: active.autoAction } : {})}
          onClose={closeDrawer}
          onActionComplete={() => {
            void load();
          }}
          {...(active.workflowId !== undefined && active.workflowPath && active.workflowName ? {
            onRunWithSameInputs: (values: { ref?: string; inputs?: ReadonlyArray<{ name: string; value: string }> }) => {
              openDrawer({
                kind: "companion",
                workflowId: active.workflowId!,
                workflowPath: active.workflowPath!,
                workflowName: active.workflowName!,
                availability: data?.workflows.find((row) => row.workflowId === active.workflowId)?.availability ?? "synced",
                initialRef: values.ref ?? active.refName ?? "",
                ...(values.inputs !== undefined ? { initialInputs: values.inputs } : {}),
                ...(active.returnTo ? { returnTo: active.returnTo } : {}),
              }, drawer.openerRowId);
            },
          } : {})}
        />
      </Drawer>
    );
  }

  return (
    <main
      ref={mainRef}
      className={`ad-drawer-host ${drawer.dockedPosition === "bottom" && !focused ? "ad-drawer-host--bottom" : ""} ${focused ? "ad-drawer-host--focused" : ""}`}
      onKeyDown={(event) => {
        if (
          event.key === "/" &&
          !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
      }}
    >
      <div className="ad-drawer-main" hidden={focused}>
        <Toolbar
          query={query}
          onQueryChange={setQuery}
          searchInputRef={searchInputRef}
          status={status}
          onStatusChange={setStatus}
          statusOptions={statusOptions}
          myRunsOnly={myRunsOnly}
          onMyRunsOnlyToggle={() => setMyRunsOnly((prev) => !prev)}
          selectedCount={selected.length}
          updated={lastUpdated}
          repositoryLabel={data ? `${data.repository.owner}/${data.repository.repo}` : undefined}
          refreshing={refreshing}
          onRefresh={() => void load()}
          onRunSelected={() => openDrawer({ kind: "batch", workflowIds: selected })}
          onOpenReleasePlan={() => openDrawer({ kind: "plan_editor", workflowIds: selected })}
          onGroupSelected={() => {
            setGroupError("");
            setPopover((current) => (current === "group" ? null : "group"));
          }}
          onOpenColumns={() => setPopover((current) => (current === "columns" ? null : "columns"))}
          onOpenActionCenter={() => openDrawer({ kind: "action_center" })}
          onOpenSettings={() => openDrawer({ kind: "settings" })}
        />

        {popover === "group" && selected.length > 0 ? (
          <GroupPicker
            count={selected.length}
            existingGroups={existingGroups}
            busy={groupBusy}
            error={groupError}
            onApply={(group) => void applyGroup(group)}
            onClose={() => setPopover(null)}
          />
        ) : null}

        {popover === "columns" ? (
          <ColumnsMenu
            layout={columnLayout}
            panelWidth={panelWidth}
            onChange={changeColumnLayout}
            onClose={() => setPopover(null)}
          />
        ) : null}

        {errorDataState ? (
          <div role="alert">
            <StateNotice
              state={errorDataState}
              inline
              action={
                errorDataState.kind === "sso" ? (
                  <Button variant="secondary" onClick={() => void load()}>
                    Authorize SSO
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void load()}>
                    Retry
                  </Button>
                )
              }
            />
          </div>
        ) : null}

        {data?.warning ? (
          <StateNotice
            kind={data.warningKind ?? "stale"}
            detail={data.warning}
            inline
          />
        ) : null}

        {data ? (
          <RunningSummary
            rows={data.workflows}
            onInspect={inspectRow}
            onOpenWorkflow={openPipeline}
          />
        ) : null}

        {plans
          .filter((plan) => plan.state !== "completed" || finishedPlanIds.includes(plan.id))
          .slice(-5)
          .map((plan) => (
            <ReleasePlanProgress
              key={plan.id}
              bridge={bridge}
              plan={plan}
              onPlanUpdated={upsertPlan}
              onInspectRun={inspectRunById}
              onOpenWorkflow={openWorkflowByPath}
              onEdit={(target) => openDrawer({ kind: "plan_editor", workflowIds: [], planId: target.id })}
              {...(plan.state === "completed"
                ? { onDismiss: () => setFinishedPlanIds((current) => current.filter((id) => id !== plan.id)) }
                : {})}
            />
          ))}

        {!data && !error ? (
          <StateNotice kind="loading" title="Loading workflows…" />
        ) : null}

        {data && rows.length === 0 ? (
          <StateNotice
            kind="empty"
            title={
              query || status !== "all" || myRunsOnly
                ? "No workflows match this filter (0 items)"
                : "No workflows found in this repository (0 items)"
            }
          />
        ) : null}

        {data && rows.length > 0 ? (
          <WorkflowTable
            groups={groupedRows}
            collapsedFolders={collapsedFolders}
            onToggleFolder={toggleFolder}
            selectedIds={selected}
            onToggleSelect={toggle}
            activeRowId={drawer.openerRowId}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={sortBy}
            historyLoadingIds={historyLoadingIds}
            onInspect={inspectRow}
            onOpen={openPipeline}
            onOpenCompanion={openCompanion}
            onOpenInTab={openPipelineInTab}
            onLoadHistory={loadHistory}
            onNotificationChange={changeNotificationMode}
            onFocusSearch={() => searchInputRef.current?.focus()}
            panelWidth={panelWidth}
            tableWrapRef={tableWrap}
            columnLayout={columnLayout}
            onColumnLayoutChange={changeColumnLayout}
          />
        ) : null}
      </div>

      {renderDrawer()}
    </main>
  );
}

const UNGROUPED = "Ungrouped";

type LatestRunPatch = Pick<WorkflowRow, "status" | "title" | "branch" | "actor" | "isMyRun" | "duration"> &
  Partial<Pick<WorkflowRow, "latestRunId" | "latestConclusion" | "latestRunAt" | "latestTriggeringActor">> & {
    workflowId: number;
  };

/** True when the patch describes a newer run, or the same run in a changed state. */
function isNewerRun(row: WorkflowRow, patch: LatestRunPatch): boolean {
  if (patch.latestRunId === undefined) return false;
  if (row.latestRunId === undefined || patch.latestRunId > row.latestRunId) return true;
  return patch.latestRunId === row.latestRunId &&
    (patch.status !== row.status || patch.duration !== row.duration || patch.latestRunAt !== row.latestRunAt);
}

function compareRows(left: WorkflowRow, right: WorkflowRow, key: SortKey): number {
  if (key === "health") return (left.metrics.passRate ?? -1) - (right.metrics.passRate ?? -1);
  if (key === "averageDuration") {
    return (left.metrics.averageDurationMs ?? -1) - (right.metrics.averageDurationMs ?? -1);
  }
  return left[key].localeCompare(right[key]);
}

function isRestrictedHistoryCode(code: string): boolean {
  return [
    "authentication_required",
    "auth_or_org_required",
    "inaccessible",
    "permission_restricted",
  ].includes(code);
}
