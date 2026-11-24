import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReleasePlan } from "../../../src/domain/models/release-plan";
import type { WorkflowRunRecord } from "../../../src/domain/models/run";
import { formatRelativeTime } from "../../../src/domain/services/relative-time";
import type { Bridge } from "../bridge";
import { Companion } from "../companion/Companion";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { StateNotice } from "../components/StateNotice";
import { StatusLabel } from "../components/StatusLabel";
import { ReleasePlanEditor } from "../dashboard/ReleasePlanEditor";
import { normalizeStatus, STATUS_DESCRIPTORS } from "../utils/status";
import { pipelineRunTiming, pipelineSummary, type PipelineSummary } from "./pipeline-metrics";

export type PipelineTab = "runs" | "run" | "schedule";

export interface PipelineWorkflow {
  readonly workflowId?: number;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly latestRunId?: number;
  readonly latestRunStatus?: string;
  readonly defaultBranch?: string;
}

interface HistoryResponse {
  readonly runs?: readonly WorkflowRunRecord[];
  readonly metrics: {
    passes: number;
    failures: number;
    sampleSize: number;
    passRate: number | null;
    averageDurationMs: number | null;
  };
  readonly hasMore?: boolean;
  readonly capped?: boolean;
  readonly page: number;
  readonly totalCount: number;
  /** Present when served from the host cache; a background refresh of the newest page follows. */
  readonly cachedAt?: number;
}

const MAX_HISTORY_PAGES = 5;
const ACTIVE_PLAN_STATES = new Set(["scheduled", "running", "paused", "waiting_approval", "on_hold", "missed_schedule"]);

/** One workflow in its own frame: recent runs, a dispatch form, and scheduling. */
export function PipelineOverview({
  bridge,
  workflow,
  plans,
  previewRefreshKey = 0,
  initialTab = "runs",
  onInspectRun,
  onPlanSaved,
}: {
  bridge: Bridge;
  workflow: PipelineWorkflow;
  plans: readonly ReleasePlan[];
  previewRefreshKey?: number;
  initialTab?: PipelineTab;
  onInspectRun(runId: number): void;
  onPlanSaved(plan: ReleasePlan): void;
}) {
  const [tab, setTab] = useState<PipelineTab>(initialTab);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [cachedAt, setCachedAt] = useState<number>();
  const [error, setError] = useState("");
  const [savedPlan, setSavedPlan] = useState<ReleasePlan>();
  const controller = useRef<AbortController | undefined>(undefined);
  const runsStale = useRef(false);
  const { workflowId } = workflow;

  const loadPage = useCallback(async (nextPage: number, preferCached = false): Promise<void> => {
    if (workflowId === undefined) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setError("");
    try {
      const response = await bridge.request<HistoryResponse>(
        "workflow.history.load",
        { workflowId, page: nextPage, ...(preferCached ? { cached: true } : {}) },
        current.signal,
      );
      if (current.signal.aborted) return;
      // The host returns every cached page merged newest first, so the list is replaced, not appended.
      setRuns([...(response.runs ?? [])]);
      setPage(response.page);
      setHasMore(Boolean(response.hasMore) && response.page < MAX_HISTORY_PAGES);
      setTotalCount(response.totalCount);
      setCachedAt(response.cachedAt);
      if (response.cachedAt !== undefined) {
        // Cached runs are on screen; refresh only the newest page, older pages stay cached.
        void loadPage(1);
        return;
      }
    } catch (reason) {
      if (!current.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (controller.current === current) setLoading(false);
    }
  }, [bridge, workflowId]);

  useEffect(() => {
    void loadPage(1, true);
    return () => controller.current?.abort();
  }, [loadPage]);

  const workflowPlans = useMemo(
    () => plans.filter((plan) =>
      ACTIVE_PLAN_STATES.has(plan.state) &&
      plan.steps.some((step) => step.workflowId === workflowId || step.workflowPath === workflow.workflowPath)),
    [plans, workflowId, workflow.workflowPath],
  );

  const selectTab = (next: PipelineTab) => {
    setTab(next);
    if (next === "runs" && runsStale.current) {
      runsStale.current = false;
      void loadPage(1);
    }
  };

  const summary = useMemo(() => pipelineSummary(runs), [runs]);
  const completedSample = useMemo(() => runs.filter((run) => run.status.toLowerCase() === "completed").slice(0, 20), [runs]);
  const knownDurations = completedSample.filter((run) => pipelineRunTiming(run).durationMs !== null).length;
  const knownQueues = completedSample.filter((run) => pipelineRunTiming(run).queueMs !== null).length;
  const medianReference = summary.medianDurationMs;
  const maxDuration = Math.max(1, ...runs.map((run) => pipelineRunTiming(run).durationMs ?? 0));
  // The chart reads left to right, oldest to latest.
  const chartRuns = useMemo(() => runs.slice(0, 20).reverse(), [runs]);
  const axis = useMemo(() => chartAxis(chartRuns), [chartRuns]);
  const recentRate = useMemo(() => {
    const recent = completedSample.slice(0, 5);
    if (recent.length < 5) return null;
    return recent.filter((run) => run.conclusion === "success").length / recent.length;
  }, [completedSample]);
  const latestDuration = completedSample[0] ? pipelineRunTiming(completedSample[0]).durationMs : null;
  const latestDelta = latestDuration !== null && medianReference ? Math.round((latestDuration / medianReference - 1) * 100) : null;
  const callout = patternCallout(runs, summary);

  const tabs: ReadonlyArray<{ id: PipelineTab; label: string }> = [
    { id: "runs", label: "Runs" },
    { id: "run", label: "Run now" },
    { id: "schedule", label: "Schedule" },
  ];

  return (
    <section className="ad-pipeline" aria-label={`${workflow.workflowName} pipeline`}>
      <div className="ad-segmented ad-pipeline__tabs" role="tablist" aria-label="Pipeline sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`pipeline-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`pipeline-panel-${item.id}`}
            className={`ad-segmented__item ${tab === item.id ? "ad-segmented__item--on" : ""}`}
            onClick={() => selectTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "runs" ? (
        <div role="tabpanel" id="pipeline-panel-runs" aria-labelledby="pipeline-tab-runs" className="ad-pipeline__panel">
          {workflowId === undefined ? (
            <StateNotice
              kind="empty"
              title="Not on GitHub yet"
              detail="Push this workflow to see its runs, trigger it, or schedule it."
              inline
            />
          ) : (
            <>
              <div className="ad-pipeline__health" aria-label="Sampled run history">
                <dl className="ad-pipeline__stats">
                  <div className="ad-pipeline__stat">
                    <dt>Pass rate{summary.completed > 0 ? ` · last ${summary.completed}` : ""}</dt>
                    <dd>
                      {summary.passRate === null ? "—" : `${Math.round(summary.passRate * 100)}%`}
                      {recentRate !== null && summary.passRate !== null && recentRate < summary.passRate ? (
                        <small className="ad-tone--failure">{Math.round(recentRate * 100)}% last 5</small>
                      ) : null}
                    </dd>
                  </div>
                  <div className="ad-pipeline__stat">
                    <dt>Median duration</dt>
                    <dd>
                      {formatDuration(summary.medianDurationMs, "—")}
                      {latestDelta !== null && Math.abs(latestDelta) >= 10 ? (
                        <small className={latestDelta > 0 ? "ad-tone--warning" : "ad-tone--success"}>
                          {latestDelta > 0 ? "▲" : "▼"} {Math.abs(latestDelta)}% last run
                        </small>
                      ) : (
                        <small>{knownLabel(knownDurations)}</small>
                      )}
                    </dd>
                  </div>
                  <div className="ad-pipeline__stat">
                    <dt>Median queue</dt>
                    <dd>
                      {formatDuration(summary.medianQueueMs, "—")}
                      <small>{knownLabel(knownQueues)}</small>
                    </dd>
                  </div>
                  <div className="ad-pipeline__stat">
                    <dt>Passed on retry</dt>
                    <dd>
                      {summary.completed > 0 ? summary.passedOnRetry : "—"}
                      {summary.passedOnRetry > 0 ? <small>flaky runs</small> : null}
                    </dd>
                  </div>
                </dl>

                <section className="ad-pipeline__chart" aria-label="Run duration history">
                  <div className="ad-pipeline__chart-head">
                    <span className="ad-pipeline__sample-label">
                      {summary.completed > 0
                        ? `${summary.completed} completed runs${hasMore ? " sampled · history incomplete" : " sampled"}`
                        : loading ? "Loading sampled runs…" : "No completed runs in this sample"}
                    </span>
                    <span className="ad-pipeline__legend" aria-hidden="true">
                      <span><i className="ad-pipeline__legend-dot ad-pipeline__legend-dot--success" />success</span>
                      <span><i className="ad-pipeline__legend-dot ad-pipeline__legend-dot--failure" />failure</span>
                      <span><i className="ad-pipeline__legend-dot" />other</span>
                      <span><i className="ad-pipeline__legend-dot ad-pipeline__legend-dot--queue" />queued</span>
                      <span className="ad-pipeline__legend-median-label"><i className="ad-pipeline__legend-median" />median</span>
                    </span>
                    <Button variant="ghost" icon="refresh" title="Refresh runs" aria-label="Refresh runs" busy={loading} onClick={() => void loadPage(1)} />
                  </div>
                  {chartRuns.length > 0 ? (
                    <>
                      <div className="ad-pipeline__plot">
                        {axis.ticks.map((tick) => (
                          <span key={tick} className="ad-pipeline__gridline" style={{ bottom: `${(tick / axis.max) * 100}%` }}>
                            <span className="ad-pipeline__tick">{formatTick(tick)}</span>
                          </span>
                        ))}
                        {medianReference !== null ? (
                          <span
                            className="ad-pipeline__median"
                            style={{ bottom: `${(medianReference / axis.max) * 100}%` }}
                            aria-label={`Median duration ${formatDuration(medianReference)}`}
                          />
                        ) : null}
                        <div className="ad-pipeline__bars">
                          {chartRuns.map((run, index) => {
                            const timing = pipelineRunTiming(run);
                            const outcome = normalizeStatus(run.status, run.conclusion);
                            const durationLabel = formatDuration(timing.durationMs);
                            const queueLabel = timing.queueMs === null ? "queue unknown" : `queued ${formatDuration(timing.queueMs)}`;
                            const detail = `Run #${run.id}: ${STATUS_DESCRIPTORS[outcome].label}, ${durationLabel === "Unavailable" ? "duration unknown" : durationLabel}, ${queueLabel}`;
                            const durationPct = timing.durationMs === null ? 6 : Math.max(2, (timing.durationMs / axis.max) * 100);
                            const queuePct = timing.queueMs === null ? 0 : (timing.queueMs / axis.max) * 100;
                            const edge = index < 3 ? "start" : index >= chartRuns.length - 3 ? "end" : "center";
                            return (
                              <button
                                key={run.id}
                                type="button"
                                className={`ad-pipeline__bar ad-pipeline__bar--${barTone(outcome)} ${timing.durationMs === null ? "ad-pipeline__bar--unknown" : ""}`}
                                aria-label={`${detail}. Open run.`}
                                onClick={() => onInspectRun(run.id)}
                              >
                                <span className="ad-pipeline__bar-stack" style={{ height: `${Math.min(100, durationPct + queuePct)}%` }}>
                                  {queuePct > 0 ? <span className="ad-pipeline__bar-queue" style={{ flexBasis: `${(queuePct / (durationPct + queuePct)) * 100}%` }} /> : null}
                                  <span className="ad-pipeline__bar-run" />
                                </span>
                                <span className={`ad-pipeline__tip ad-pipeline__tip--${edge}`} role="tooltip">
                                  <span className="ad-pipeline__tip-head">
                                    <StatusLabel status={outcome} className="ad-status--tinted" still />
                                    <span className="ad-pipeline__tip-id">#{run.id}</span>
                                  </span>
                                  <span>Run {durationLabel === "Unavailable" ? "duration unknown" : durationLabel} · {queueLabel}</span>
                                  <span className="ad-muted">{[run.actor?.login, formatRelativeTime(run.createdAt)].filter(Boolean).join(" · ")}</span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="ad-pipeline__axis-x" aria-hidden="true">
                        <span>{chartRuns.length} runs ago</span>
                        <span>latest</span>
                      </div>
                    </>
                  ) : null}
                </section>
              </div>

              {callout ? (
                <div className="ad-pipeline__callout" role="note">
                  <Icon name={callout.icon} size={16} className="ad-pipeline__callout-icon" />
                  <span>{callout.text}</span>
                  {callout.runId !== undefined ? (
                    <Button variant="secondary" icon="search" onClick={() => onInspectRun(callout.runId!)}>
                      Inspect latest failure
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {workflowPlans.length > 0 ? (
                <>
                  <h3 className="ad-section ad-pipeline__heading">Scheduled and active plans</h3>
                  <ul className="ad-pipeline__list" aria-label="Scheduled plans">
                    {workflowPlans.map((plan) => (
                      <li key={plan.id} className="ad-pipeline__plan">
                        <StatusLabel status={plan.state} label={planStateLabel(plan.state)} />
                        <span className="ad-pipeline__title">{plan.name}</span>
                        <span className="ad-muted ad-mono-sm">{planWhen(plan)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              <h3 className="ad-section ad-pipeline__heading">
                Recent runs
                {totalCount !== undefined ? <span className="ad-pipeline__count">{runs.length} of {totalCount}</span> : null}
                {runs.length > 0 && loading ? (
                  <span className="ad-pipeline__updating" role="status">
                    {cachedAt !== undefined ? ` · cached ${formatRelativeTime(cachedAt) ?? "recently"}` : ""} · updating…
                  </span>
                ) : null}
              </h3>
              {error ? <StateNotice kind="stale" title="Could not load runs" detail={error} inline /> : null}
              {!loading && !error && runs.length === 0 ? (
                <StateNotice kind="empty" title="No runs yet" detail="This workflow has not run on GitHub." inline />
              ) : null}
              {runs.length > 0 ? (
                <ul className="ad-pipeline__runs" aria-label="Recent runs">
                  {runs.map((run) => {
                    const timing = pipelineRunTiming(run);
                    const outcome = normalizeStatus(run.status, run.conclusion);
                    const tag = runTag(run, outcome);
                    const meta = [run.branch || "branch unknown", run.event, run.actor?.login, formatRelativeTime(run.createdAt)]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li key={run.id}>
                        <button
                          type="button"
                          className="ad-pipeline__run"
                          onClick={() => onInspectRun(run.id)}
                          aria-label={`Open run #${run.id}, ${run.displayTitle}`}
                        >
                          <StatusLabel status={outcome} iconOnly />
                          <span className="ad-pipeline__run-main">
                            <span className="ad-pipeline__title" title={run.displayTitle}>{run.displayTitle}</span>
                            <span className="ad-pipeline__meta">{meta}</span>
                          </span>
                          <span className="ad-pipeline__run-tag">
                            {tag ? <span className={`ad-row-signal ad-row-signal--${tag.kind}`}>{tag.kind === "flaky" ? <Icon name="debug-rerun" size={12} /> : null}{tag.label}</span> : null}
                          </span>
                          <span className="ad-pipeline__run-duration">
                            <span className="ad-num">{formatDuration(timing.durationMs, "—")}</span>
                            <span className="ad-pipeline__dur-bar">
                              <i
                                className={`ad-pipeline__dur-fill ad-pipeline__dur-fill--${barTone(outcome)}`}
                                style={{ width: `${timing.durationMs === null ? 0 : Math.max(3, (timing.durationMs / maxDuration) * 100)}%` }}
                              />
                            </span>
                          </span>
                          <span className="ad-pipeline__run-id">#{run.id}</span>
                          <Icon name="chevron-right" size={14} className="ad-pipeline__run-chevron" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {hasMore ? (
                <Button variant="secondary" busy={loading} onClick={() => void loadPage(page + 1)}>Load more runs</Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {tab === "run" ? (
        <div role="tabpanel" id="pipeline-panel-run" aria-labelledby="pipeline-tab-run">
          <Companion
            bridge={bridge}
            {...(workflowId === undefined ? {} : { workflowId })}
            workflowPath={workflow.workflowPath}
            workflowName={workflow.workflowName}
            {...(workflow.latestRunId === undefined ? {} : { latestRunId: workflow.latestRunId })}
            {...(workflow.latestRunStatus ? { latestRunStatus: workflow.latestRunStatus } : {})}
            previewRefreshKey={previewRefreshKey}
            previousRuns={runs}
            onInspectLatest={() => {
              if (workflow.latestRunId !== undefined) onInspectRun(workflow.latestRunId);
            }}
            onInspectRun={onInspectRun}
            onDispatched={() => { runsStale.current = true; }}
            onClose={() => selectTab("runs")}
          />
        </div>
      ) : null}

      {tab === "schedule" ? (
        <div role="tabpanel" id="pipeline-panel-schedule" aria-labelledby="pipeline-tab-schedule">
          {workflowId === undefined ? (
            <StateNotice kind="empty" title="Push this workflow to schedule it" inline />
          ) : (
            <>
              {savedPlan ? (
                <p className="ad-caption" role="status">
                  Saved “{savedPlan.name}” ({planStateLabel(savedPlan.state)}{planWhen(savedPlan) ? `, ${planWhen(savedPlan)}` : ""}).
                </p>
              ) : null}
              <ReleasePlanEditor
                key={savedPlan?.id ?? "new"}
                bridge={bridge}
                heading={`Schedule ${workflow.workflowName}`}
                initialName={`Scheduled ${workflow.workflowName}`}
                defaultScheduleMode="relative"
                workflows={[{
                  workflowId,
                  name: workflow.workflowName,
                  path: workflow.workflowPath,
                  ...(workflow.defaultBranch ? { defaultBranch: workflow.defaultBranch } : {}),
                }]}
                onSaved={(plan) => {
                  setSavedPlan(plan);
                  onPlanSaved(plan);
                }}
                onClose={() => setTab("runs")}
              />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function formatDuration(ms: number | null | undefined, unknown = "Unavailable"): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return unknown;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function knownLabel(known: number): string {
  return known > 0 ? `${known} known` : "unknown";
}

function barTone(outcome: string): "success" | "failure" | "other" {
  if (outcome === "success") return "success";
  if (outcome === "failure") return "failure";
  return "other";
}

const TICK_STEPS_MS = [10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000];

/** A y-axis with at most four round ticks and ~10% headroom over the tallest bar (duration + queue). */
function chartAxis(runs: readonly WorkflowRunRecord[]): { max: number; ticks: number[] } {
  const tallest = Math.max(1_000, ...runs.map((run) => {
    const timing = pipelineRunTiming(run);
    return (timing.durationMs ?? 0) + (timing.queueMs ?? 0);
  }));
  const max = tallest * 1.1;
  const step = TICK_STEPS_MS.find((candidate) => max / candidate <= 4) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max; tick += step) ticks.push(tick);
  return { max, ticks };
}

function formatTick(ms: number): string {
  if (ms === 0) return "0";
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}m`;
  return `${ms / 3_600_000}h`;
}

function runTag(run: WorkflowRunRecord, outcome: string): { kind: "flaky" | "failure"; label: string } | null {
  if (run.attemptCount > 1 && run.conclusion === "success") return { kind: "flaky", label: `flaky · attempt ${run.attemptCount}` };
  if (run.attemptCount > 1 && outcome === "failure") return { kind: "failure", label: `attempt ${run.attemptCount}` };
  return null;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

function patternCallout(
  runs: readonly WorkflowRunRecord[],
  summary: PipelineSummary,
): { icon: string; text: string; runId?: number } | null {
  const recent = runs.filter((run) => run.status === "completed").slice(0, 5);
  const failed = recent.filter((run) => run.conclusion && FAILED.has(run.conclusion));
  const latestFailure = failed[0]?.id;
  if (recent.length >= 3 && failed.length >= 3) {
    const lead = recent[0]?.conclusion === "success" && recent[0].attemptCount > 1
      ? ` The latest run passed only on attempt ${recent[0].attemptCount}.`
      : "";
    return {
      icon: "flame",
      text: `${failed.length} of the last ${recent.length} completed runs failed.${lead}`,
      ...(latestFailure !== undefined ? { runId: latestFailure } : {}),
    };
  }
  if (summary.passedOnRetry >= 2 && summary.completed >= 3) {
    return {
      icon: "debug-rerun",
      text: `${summary.passedOnRetry} of ${summary.completed} sampled completed runs passed only after a retry.`,
    };
  }
  return null;
}

function planStateLabel(state: string): string {
  return state.replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function planWhen(plan: ReleasePlan): string {
  const runAtMs = plan.schedule?.runAtMs;
  if (!runAtMs) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(runAtMs));
}
