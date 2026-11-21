import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { StatusLabel } from "./StatusLabel";
import { AvailabilityBadge } from "./AvailabilityBadge";
import { MetricCell } from "./MetricCell";
import { formatDurationMs } from "../utils/health-metrics";
import { formatRelativeTime } from "../../../src/domain/services/relative-time";
import type { WorkflowRunRecord } from "../../../src/domain/models/run";
import { mapWorkflowAvailability, normalizeStatus } from "../utils/status";
import {
  autoHiddenColumns,
  COLUMN_LABELS,
  DEFAULT_COLUMN_LAYOUT,
  moveColumn,
  setColumnWidth,
  type ColumnLayout,
  type ConfigurableColumnId,
  type ResizableColumnId,
} from "../utils/columns";

export type SortKey =
  | "name"
  | "folder"
  | "availability"
  | "status"
  | "title"
  | "branch"
  | "actor"
  | "duration"
  | "health"
  | "averageDuration";

export type NotificationMode = "my_runs_only" | "all_runs" | "muted";

const NOTIFICATION_LABELS: Record<NotificationMode, string> = {
  my_runs_only: "My Runs Only",
  all_runs: "All Runs",
  muted: "Muted",
};

const NOTIFICATION_ICONS: Record<NotificationMode, string> = {
  my_runs_only: "bell",
  all_runs: "bell-dot",
  muted: "bell-slash",
};

const SIGNAL_ICONS: Record<DeckSignal["kind"], string> = {
  failure: "flame",
  flaky: "debug-rerun",
  slowdown: "watch",
  reconciliation: "question",
};

interface CellContext {
  isHistoryLoading: boolean;
  showLoadHistory: boolean;
  rowStatus: string;
  signals: readonly DeckSignal[];
  slowdown: DeckSignal | undefined;
  progressStyle: React.CSSProperties | undefined;
}

/** Estimated progress of a running row against its typical duration, capped so it never looks finished. */
function runningProgress(row: WorkflowTableRowData): React.CSSProperties | undefined {
  const startedAt = row.latestRun?.runStartedAt ? Date.parse(row.latestRun.runStartedAt) : Number.NaN;
  const typical = row.metrics.medianDurationMs ?? row.metrics.averageDurationMs;
  if (!Number.isFinite(startedAt) || !typical) return undefined;
  const ratio = Math.min(0.95, Math.max(0.04, (Date.now() - startedAt) / typical));
  return { width: `${Math.round(ratio * 100)}%` };
}

export interface WorkflowTableRowData {
  id: string;
  workflowId?: number;
  latestRunId?: number;
  name: string;
  path: string;
  folder: string;
  availability: string;
  historyHydration: "not_loaded" | "partial" | "loaded" | "restricted";
  status: string;
  title: string;
  branch: string;
  actor: string;
  isMyRun: boolean;
  duration: string;
  latestConclusion?: string | null;
  latestRunAt?: string;
  latestTriggeringActor?: string;
  latestRun?: WorkflowRunRecord;
  reconciliation?: "not_observed" | "unavailable";
  notificationMode?: NotificationMode;
  metrics: {
    passes: number;
    failures: number;
    sampleSize: number;
    scope: string;
    passRate: number | null;
    averageDurationMs: number | null;
    medianDurationMs?: number | null;
  };
  historyPartial?: boolean;
  historyCapped?: boolean;
  historyPage?: number;
}

export interface WorkflowTableProps {
  groups: readonly (readonly [string, readonly WorkflowTableRowData[]])[];
  collapsedFolders: readonly string[];
  onToggleFolder: (folder: string) => void;
  selectedIds: readonly string[];
  onToggleSelect: (id: string) => void;
  activeRowId?: string | null | undefined;
  sortKey: SortKey;
  sortDirection: 1 | -1;
  onSort: (key: SortKey) => void;
  historyLoadingIds: readonly number[];
  onInspect: (row: WorkflowTableRowData) => void;
  /** Opens the workflow itself (pipeline overview). Triggered by row click and Enter. */
  onOpen: (row: WorkflowTableRowData) => void;
  onOpenCompanion: (row: WorkflowTableRowData) => void;
  /** Opens the pipeline in its own editor tab. Triggered by double-click, Cmd/Ctrl+click, middle-click and Cmd/Ctrl+Enter. */
  onOpenInTab?: ((row: WorkflowTableRowData) => void) | undefined;
  onLoadHistory: (row: WorkflowTableRowData) => void;
  onNotificationChange: (row: WorkflowTableRowData, mode: NotificationMode) => void;
  onFocusSearch?: () => void;
  panelWidth?: number | undefined;
  tableWrapRef?: React.RefObject<HTMLDivElement | null> | undefined;
  still?: boolean | undefined;
  columnLayout?: ColumnLayout | undefined;
  /** Called when the user drags a header to reorder it or drags its edge to resize it. */
  onColumnLayoutChange?: ((layout: ColumnLayout) => void) | undefined;
}

export interface DeckSignal {
  readonly kind: "failure" | "flaky" | "slowdown" | "reconciliation";
  readonly label: string;
  readonly detail: string;
}

export function deckSignals(row: WorkflowTableRowData): readonly DeckSignal[] {
  const signals: DeckSignal[] = [];
  if (
    normalizeStatus(row.status) === "failure" &&
    row.metrics.sampleSize >= 2 &&
    row.metrics.failures === row.metrics.sampleSize
  ) {
    const streak = row.metrics.failures;
    signals.push({
      kind: "failure",
      label: `${streak}× in a row`,
      detail: `${streak} observed consecutive failures`,
    });
  }

  const latestRun = row.latestRun;
  if (latestRun?.conclusion === "success" && latestRun.attemptCount > 1) {
    signals.push({
      kind: "flaky",
      label: "flaky",
      detail: `Passed on retry (attempt ${latestRun.attemptCount})`,
    });
  }

  const median = row.metrics.medianDurationMs;
  const durationMs = completedDurationMs(row);
  if (
    row.metrics.sampleSize >= 3 &&
    median !== null &&
    median !== undefined &&
    median > 0 &&
    durationMs !== null &&
    durationMs / median > 1.25
  ) {
    const percent = Math.round((durationMs / median - 1) * 100);
    signals.push({
      kind: "slowdown",
      label: `▲ ${percent}%`,
      detail: `Latest run is ${percent}% slower than the recent median`,
    });
  }

  if (row.reconciliation) {
    signals.push({
      kind: "reconciliation",
      label: row.reconciliation === "not_observed" ? "Run not observed" : "Outcome unavailable",
      detail: "Refresh before retrying; the dispatch outcome is not confirmed",
    });
  }
  return signals;
}

function completedDurationMs(row: WorkflowTableRowData): number | null {
  const latestRun = row.latestRun;
  if (latestRun?.runStartedAt && latestRun.completedAt) {
    const value = Date.parse(latestRun.completedAt) - Date.parse(latestRun.runStartedAt);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const match = row.duration.match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (!match) return null;
  return (Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1_000;
}

const COLUMN_SORT_KEYS: Partial<Record<ConfigurableColumnId, SortKey>> = {
  availability: "availability",
  lastRun: "status",
  branch: "branch",
  actor: "actor",
  duration: "duration",
  health: "health",
};

export function WorkflowTable({
  groups,
  collapsedFolders,
  onToggleFolder,
  selectedIds,
  onToggleSelect,
  activeRowId,
  sortKey,
  sortDirection,
  onSort,
  historyLoadingIds,
  onInspect,
  onOpen,
  onOpenCompanion,
  onOpenInTab,
  onLoadHistory,
  onNotificationChange,
  onFocusSearch,
  panelWidth = 1000,
  tableWrapRef,
  still = false,
  columnLayout = DEFAULT_COLUMN_LAYOUT,
  onColumnLayoutChange,
}: WorkflowTableProps): React.JSX.Element {
  // User-hidden columns, plus progressive hiding on narrow panels (Path -> Actor -> Branch -> Duration; never Last run).
  const autoHidden = autoHiddenColumns(panelWidth);
  const visibleColumns = columnLayout.order.filter(
    (id) => !columnLayout.hidden.includes(id) && !autoHidden.has(id),
  );
  const showSlowdownInDuration = visibleColumns.includes("duration");
  // Checkbox + Workflow + configurable columns + Actions.
  const totalColumnCount = visibleColumns.length + 3;

  const [dragColumn, setDragColumn] = useState<ConfigurableColumnId | null>(null);
  const [dropTarget, setDropTarget] = useState<ConfigurableColumnId | null>(null);

  const [focusedKey, setFocusedKey] = useState<string | null>(activeRowId ?? null);
  const tableRef = useRef<HTMLTableElement>(null);

  const firstNavKey = useMemo(() => {
    for (const [folder] of groups) {
      return `folder:${folder}`;
    }
    return null;
  }, [groups]);

  useEffect(() => {
    if (activeRowId) {
      setFocusedKey(`row:${activeRowId}`);
    }
  }, [activeRowId]);

  const effectiveFocusKey = focusedKey ?? firstNavKey;

  function sortButton(label: string, key: SortKey | undefined) {
    if (!key) return <span className="ad-th__label">{label}</span>;
    const current = sortKey === key;
    return (
      <button type="button" className="ad-btn ad-btn--ghost" onClick={() => onSort(key)}>
        <span>{label}</span>
        {current ? <Icon name={sortDirection === 1 ? "arrow-up" : "arrow-down"} size={12} /> : null}
      </button>
    );
  }

  function startResize(event: React.PointerEvent<HTMLSpanElement>, id: ResizableColumnId) {
    if (!onColumnLayoutChange) return;
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.closest("th");
    if (!header) return;
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    let latest = columnLayout;
    const onMove = (move: PointerEvent) => {
      latest = setColumnWidth(columnLayout, id, startWidth + move.clientX - startX);
      header.style.width = `${latest.widths[id]}px`;
      header.style.minWidth = `${latest.widths[id]}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (latest !== columnLayout) onColumnLayoutChange(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resizeByKeyboard(event: React.KeyboardEvent<HTMLSpanElement>, id: ResizableColumnId) {
    if (!onColumnLayoutChange) return;
    const header = event.currentTarget.closest("th");
    const width = columnLayout.widths[id] ?? header?.getBoundingClientRect().width ?? 120;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      onColumnLayoutChange(setColumnWidth(columnLayout, id, width + (event.key === "ArrowRight" ? 16 : -16)));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      onColumnLayoutChange(setColumnWidth(columnLayout, id, undefined));
    }
  }

  function resizeHandle(id: ResizableColumnId, label: string) {
    if (!onColumnLayoutChange) return null;
    return (
      <span
        className="ad-th__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={(event) => startResize(event, id)}
        onDoubleClick={() => onColumnLayoutChange(setColumnWidth(columnLayout, id, undefined))}
        onKeyDown={(event) => resizeByKeyboard(event, id)}
        onClick={(event) => event.stopPropagation()}
      />
    );
  }

  function widthStyle(id: ResizableColumnId): React.CSSProperties | undefined {
    const width = columnLayout.widths[id];
    return width === undefined ? undefined : { width, minWidth: width, maxWidth: width };
  }

  function columnHeader(id: ConfigurableColumnId) {
    const label = COLUMN_LABELS[id];
    const key = COLUMN_SORT_KEYS[id];
    const draggable = Boolean(onColumnLayoutChange);
    return (
      <th
        key={id}
        data-column={id}
        aria-sort={key && sortKey === key ? (sortDirection === 1 ? "ascending" : "descending") : undefined}
        className={[
          id === "duration" ? "ad-cell--right" : "",
          dropTarget === id && dragColumn !== id ? "ad-th--drop" : "",
          dragColumn === id ? "ad-th--dragging" : "",
        ].filter(Boolean).join(" ") || undefined}
        style={widthStyle(id)}
        draggable={draggable}
        title={draggable ? "Drag to reorder" : undefined}
        onDragStart={(event) => {
          setDragColumn(id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
        }}
        onDragOver={(event) => {
          if (!dragColumn) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (dropTarget !== id) setDropTarget(id);
        }}
        onDragLeave={() => {
          if (dropTarget === id) setDropTarget(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragColumn && dragColumn !== id && onColumnLayoutChange) {
            onColumnLayoutChange(moveColumn(columnLayout, dragColumn, columnLayout.order.indexOf(id)));
          }
          setDragColumn(null);
          setDropTarget(null);
        }}
        onDragEnd={() => {
          setDragColumn(null);
          setDropTarget(null);
        }}
      >
        {id === "notifications" ? (
          <span className="ad-th__label ad-th__label--icon" title={label} aria-label={label}>
            <Icon name="bell" size={14} />
          </span>
        ) : sortButton(label, key)}
        {resizeHandle(id, label)}
      </th>
    );
  }

  function columnCell(id: ConfigurableColumnId, row: WorkflowTableRowData, context: CellContext) {
    const style = widthStyle(id);
    switch (id) {
      case "path":
        return (
          <td key={id} className="ad-cell--path ad-path" title={row.path} style={style}>
            {row.path}
          </td>
        );
      case "availability":
        return (
          <td key={id} style={style}>
            {mapWorkflowAvailability(row.availability).value !== "synced" ? <AvailabilityBadge value={row.availability} /> : null}
          </td>
        );
      case "lastRun":
        return (
          <td key={id} style={style}>
            <div className="ad-lastrun">
              {row.latestRunId !== undefined ? (
                <button
                  type="button"
                  className="ad-lastrun__link"
                  aria-label={`Inspect latest run for ${row.name}`}
                  title={`Open latest run #${row.latestRunId}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onInspect(row);
                  }}
                >
                  <StatusLabel status={row.status} still={still} className="ad-status--tinted" />
                </button>
              ) : (
                <StatusLabel status={row.status} still={still} className="ad-status--tinted" />
              )}
              {context.rowStatus === "running" ? (
                <span className="ad-progress" aria-hidden="true"><i style={context.progressStyle} /></span>
              ) : null}
              {context.signals.map((signal) => (
                <span
                  key={signal.kind}
                  className={`ad-row-signal ad-row-signal--${signal.kind}`}
                  title={signal.detail}
                >
                  <Icon name={SIGNAL_ICONS[signal.kind]} size={12} />
                  {signal.label}
                </span>
              ))}
              {row.latestRunId !== undefined ? (
                <span className="ad-lastrun__id">#{row.latestRunId}</span>
              ) : null}
              {row.latestRunAt ? (
                <span className="ad-lastrun__time">{formatRelativeTime(row.latestRunAt)}</span>
              ) : null}
              {context.showLoadHistory ? (
                <Button
                  variant="ghost"
                  busy={context.isHistoryLoading}
                  onClick={(event) => {
                    event.stopPropagation();
                    onLoadHistory(row);
                  }}
                >
                  {context.isHistoryLoading ? "Loading…" : "Load history"}
                </Button>
              ) : null}
            </div>
          </td>
        );
      case "branch":
        return (
          <td key={id} className="ad-mono-sm ad-cell--clip" title={row.branch} style={style}>
            {row.branch}
          </td>
        );
      case "actor":
        return (
          <td key={id} className="ad-cell--clip" title={row.actor} style={style}>
            <span className={row.isMyRun ? "ad-you" : undefined}>{row.isMyRun ? "you" : row.actor}</span>
            {row.latestTriggeringActor ? (
              <span className="ad-caption ad-muted"> · re-run by {row.latestTriggeringActor}</span>
            ) : null}
          </td>
        );
      case "duration":
        return (
          <td key={id} className="ad-cell--right ad-num" style={style}>
            {context.rowStatus === "running" ? (
              <span className="ad-muted" title="Typical duration">
                {row.metrics.averageDurationMs ? `~${formatDurationMs(row.metrics.averageDurationMs)}` : "—"}
              </span>
            ) : row.duration === "Not available" ? (
              <span className="ad-muted">—</span>
            ) : (
              row.duration
            )}
            {context.slowdown ? (
              <span className="ad-delta" title={context.slowdown.detail}>{context.slowdown.label}</span>
            ) : null}
          </td>
        );
      case "health":
        return (
          <td key={id} style={style}>
            {row.metrics.sampleSize === 0 && row.historyHydration === "restricted" ? (
              <span className="ad-muted ad-caption">History restricted</span>
            ) : row.metrics.sampleSize === 0 && row.historyHydration === "not_loaded" ? (
              <span className="ad-muted ad-caption">History unknown</span>
            ) : (
              <MetricCell
                passRate={row.metrics.passRate}
                sample={row.metrics.sampleSize}
                passes={row.metrics.passes}
                failures={row.metrics.failures}
                partial={Boolean(row.historyPartial || row.historyCapped)}
                avg={formatDurationMs(row.metrics.averageDurationMs)}
              />
            )}
          </td>
        );
      case "notifications":
        return (
          <td key={id} style={style} onClick={(event) => event.stopPropagation()}>
            <span
              className={`ad-notification-menu ad-notification-menu--${row.notificationMode ?? "my_runs_only"}`}
              title={`Notifications: ${NOTIFICATION_LABELS[row.notificationMode ?? "my_runs_only"]}`}
            >
              <Icon name={NOTIFICATION_ICONS[row.notificationMode ?? "my_runs_only"]} size={14} />
              <select
                aria-label={`Notifications for ${row.name}`}
                disabled={row.workflowId === undefined}
                value={row.notificationMode ?? "my_runs_only"}
                onChange={(event) => onNotificationChange(row, event.target.value as NotificationMode)}
              >
                {(Object.keys(NOTIFICATION_LABELS) as NotificationMode[]).map((mode) => (
                  <option value={mode} key={mode}>
                    {NOTIFICATION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </span>
          </td>
        );
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "/" &&
      !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
    ) {
      event.preventDefault();
      onFocusSearch?.();
      return;
    }

    const targetRow =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("tr[data-nav-key]")
        : null;
    if (!targetRow || event.target !== targetRow) return;

    const allNavRows = [
      ...(tableRef.current?.querySelectorAll<HTMLElement>("tr[data-nav-key]") ?? []),
    ];
    const index = allNavRows.indexOf(targetRow);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = allNavRows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        const key = next.dataset.navKey ?? null;
        setFocusedKey(key);
        next.focus({ preventScroll: true });
      }
      return;
    }

    const folderName = targetRow.dataset.folder;
    if (folderName !== undefined) {
      const isCollapsed = collapsedFolders.includes(folderName);
      if (event.key === "ArrowRight" && isCollapsed) {
        event.preventDefault();
        onToggleFolder(folderName);
      } else if (event.key === "ArrowLeft" && !isCollapsed) {
        event.preventDefault();
        onToggleFolder(folderName);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onToggleFolder(folderName);
      }
      return;
    }

    const rowId = targetRow.dataset.rowId;
    if (!rowId) return;

    const row = groups
      .flatMap(([, items]) => items)
      .find((item) => item.id === rowId);
    if (!row) return;

    if (event.key === "ArrowLeft" && row.folder) {
      const folderRow = allNavRows.find((el) => el.dataset.folder === row.folder);
      if (folderRow) {
        event.preventDefault();
        setFocusedKey(folderRow.dataset.navKey ?? null);
        folderRow.focus({ preventScroll: true });
      }
      return;
    }

    if (event.key === " ") {
      event.preventDefault();
      onToggleSelect(row.id);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onOpenCompanion(row);
      } else if ((event.metaKey || event.ctrlKey) && onOpenInTab) {
        onOpenInTab(row);
      } else {
        onOpen(row);
      }
    }
  }

  return (
    <div className="ad-table-wrap table-wrap" ref={tableWrapRef} onKeyDown={handleKeyDown}>
      <table ref={tableRef} className="ad-table" role="treegrid" aria-label="Workflows">
        <thead>
          <tr>
            <th className="ad-cell--check" aria-label="Select" />
            <th
              data-column="name"
              aria-sort={sortKey === "name" ? (sortDirection === 1 ? "ascending" : "descending") : "none"}
              style={widthStyle("name")}
            >
              {sortButton("Workflow", "name")}
              {resizeHandle("name", "Workflow")}
            </th>
            {visibleColumns.map((id) => columnHeader(id))}
            <th className="ad-cell--actions" aria-label="Actions" />
          </tr>
        </thead>
        {groups.map(([folder, folderRows]) => {
          const isCollapsed = collapsedFolders.includes(folder);
          const folderNavKey = `folder:${folder}`;
          return (
            <tbody key={folder}>
              <tr
                className="ad-folder"
                role="row"
                aria-level={1}
                aria-expanded={!isCollapsed}
                data-nav-key={folderNavKey}
                data-folder={folder}
                tabIndex={effectiveFocusKey === folderNavKey ? 0 : -1}
              >
                <td colSpan={totalColumnCount}>
                  <button
                    type="button"
                    className="ad-btn ad-btn--ghost ad-folder__label"
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleFolder(folder)}
                  >
                    <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={14} />
                    <span>{folder}</span>
                    <span className="ad-badge">{folderRows.length}</span>
                  </button>
                </td>
              </tr>
              {!isCollapsed &&
                folderRows.map((row) => {
                  const isChecked = selectedIds.includes(row.id);
                  const isActive = activeRowId === row.id;
                  const rowNavKey = `row:${row.id}`;
                  const isHistoryLoading =
                    row.workflowId !== undefined && historyLoadingIds.includes(row.workflowId);
                  const showLoadHistory =
                    row.workflowId !== undefined &&
                    row.historyHydration === "not_loaded" &&
                    row.metrics.sampleSize === 0;
                  const isDisabledTrigger = row.availability === "local_only";
                  const signals = deckSignals(row);
                  const rowStatus = normalizeStatus(row.status);

                  return (
                    <tr
                      key={row.id}
                      className={`ad-row ad-row--clickable ad-row--${rowStatus} ${isActive || isChecked ? "ad-row--selected" : ""}`}
                      role="row"
                      aria-level={2}
                      aria-selected={isChecked}
                      data-row-id={row.id}
                      data-nav-key={rowNavKey}
                      tabIndex={effectiveFocusKey === rowNavKey ? 0 : -1}
                      title={onOpenInTab ? `Open ${row.name} · double-click to open in a tab` : `Open ${row.name}`}
                      onClick={(event) => {
                        setFocusedKey(rowNavKey);
                        if ((event.metaKey || event.ctrlKey) && onOpenInTab) onOpenInTab(row);
                        else if (event.detail <= 1) onOpen(row);
                      }}
                      onDoubleClick={onOpenInTab ? () => onOpenInTab(row) : undefined}
                      onAuxClick={onOpenInTab ? (event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          onOpenInTab(row);
                        }
                      } : undefined}
                    >
                      <td className="ad-cell--check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.name}`}
                          checked={isChecked}
                          onChange={() => onToggleSelect(row.id)}
                        />
                      </td>

                      <td
                        className="ad-cell--name"
                        title={`${row.name} (${row.path})`}
                        style={widthStyle("name")}
                      >
                        <span className="ad-name-cell">
                          <span className="ad-name">{row.name}</span>
                          {mapWorkflowAvailability(row.availability).value !== "synced" && !visibleColumns.includes("availability") ? (
                            <AvailabilityBadge value={row.availability} className="ad-avail--pill" />
                          ) : null}
                        </span>
                      </td>

                      {visibleColumns.map((id) => columnCell(id, row, {
                        isHistoryLoading,
                        showLoadHistory,
                        rowStatus,
                        signals: showSlowdownInDuration ? signals.filter((signal) => signal.kind !== "slowdown") : signals,
                        slowdown: showSlowdownInDuration ? signals.find((signal) => signal.kind === "slowdown") : undefined,
                        progressStyle: rowStatus === "running" ? runningProgress(row) : undefined,
                      }))}

                      <td className="ad-cell--actions" onClick={(event) => event.stopPropagation()}>
                        {row.workflowId !== undefined ? (
                          <Button
                            variant="ghost"
                            icon="play"
                            disabled={isDisabledTrigger}
                            title={
                              isDisabledTrigger
                                ? "Push this workflow to run it"
                                : `Trigger ${row.name}`
                            }
                            onClick={() => onOpenCompanion(row)}
                          />
                        ) : null}
                        {onOpenInTab ? (
                          <Button
                            variant="ghost"
                            icon="link-external"
                            title={`Open ${row.name} in a tab`}
                            aria-label={`Open ${row.name} in a tab`}
                            onClick={() => onOpenInTab(row)}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
