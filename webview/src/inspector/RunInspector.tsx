import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getWebviewState, setWebviewState, type Bridge } from "../bridge";
import { parseSupportedGitHubRunUrl } from "../../../src/domain/services/external-links";
import { RunActions } from "./RunActions";
import { PendingApprovals } from "./PendingApprovals";
import { StatusLabel } from "../components/StatusLabel";
import { JobTree, type JobTreeJob } from "../components/JobTree";
import { LogViewer, parseLogLines } from "../components/LogViewer";
import { StateNotice } from "../components/StateNotice";
import { CopilotAction } from "../components/CopilotAction";
import { FailureExplanation, type FailureExplanationSummary } from "./FailureExplanation";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { normalizeStatus } from "../utils/status";
import { mapLogAvailabilityToDataState } from "../utils/data-state";
import { formatDurationMs } from "../utils/health-metrics";
import { formatRelativeTime } from "../../../src/domain/services/relative-time";
import { isSensitiveInputName } from "../../../src/domain/services/plan-transitions";
import type { WorkflowRunRecord } from "../../../src/domain/models/run";
import { DEFAULT_RUN_REFRESH_SECONDS, normalizeRunRefreshSeconds, RUN_REFRESH_OPTIONS } from "../../../src/domain/models/settings";

interface InspectedRun {
  runId: number;
  attempt: number;
  attemptCount: number;
  title: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  workflowId?: number;
  workflowPath?: string;
  ref?: string;
  headSha?: string;
  actor?: string;
  isMyRun?: boolean;
  createdAt?: string;
  /** Inputs ActionDeck sent when it dispatched this run; GitHub does not report them. */
  dispatchInputs?: Array<{ name: string; value: string }>;
  dependencyResolution: "resolved" | "unresolved" | "unavailable";
  jobs: Array<{
    id: number;
    runId: number;
    attempt: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt?: string;
    completedAt?: string;
    needs?: string[];
    steps: Array<{
      number: number;
      name: string;
      status: string;
      conclusion: string | null;
      startedAt?: string;
      completedAt?: string;
    }>;
  }>;
}

interface HistoryResponse {
  runs?: readonly WorkflowRunRecord[];
}

interface Comparison {
  baseline: InspectedRun;
  baselineRunId: number;
}

interface LogExcerpt {
  text: string;
  truncated: boolean;
  availability: string;
  stepNumber?: number;
  stepBoundary?: "identified" | "unidentified";
  message?: string;
}

const READABLE_LOG_STATES = new Set(["loaded", "truncated"]);
// While a run is active the inspector refreshes itself at the chosen interval (actiondeck.runRefreshInterval
// by default). Hidden panels and finished runs are never refreshed.
function refreshLabel(seconds: number): string {
  return seconds === 0 ? "Auto-refresh off" : `Refresh every ${seconds}s`;
}

function selectionStatus(run: InspectedRun, jobId: number, stepNumber?: number): string | undefined {
  const job = run.jobs.find((candidate) => candidate.id === jobId);
  return stepNumber === undefined ? job?.status : job?.steps.find((step) => step.number === stepNumber)?.status;
}

function isFailed(value: { conclusion: string | null }): boolean {
  return value.conclusion === "failure" || value.conclusion === "timed_out";
}

function elapsedLabel(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? formatDurationMs(duration) : undefined;
}

type InvestigationSummary = FailureExplanationSummary;

export function RunInspector({
  bridge,
  runId,
  defaultRefreshSeconds = DEFAULT_RUN_REFRESH_SECONDS,
  workflowId,
  refName,
  autoAction,
  onClose,
  onActionComplete,
  onRunWithSameInputs,
}: {
  bridge: Bridge;
  runId: number;
  /** Auto-refresh interval in seconds from the actiondeck.runRefreshInterval setting; 0 means off. */
  defaultRefreshSeconds?: number;
  workflowId?: number;
  refName?: string;
  autoAction?: "explain" | "investigate";
  onClose(): void;
  onActionComplete?(): void;
  onRunWithSameInputs?(values: { ref?: string; inputs?: ReadonlyArray<{ name: string; value: string }> }): void;
}) {
  const [inspection, setInspection] = useState<InspectedRun>();
  const [savedDefaultSeconds, setSavedDefaultSeconds] = useState(() => normalizeRunRefreshSeconds(defaultRefreshSeconds));
  const [refreshSeconds, setRefreshSeconds] = useState<number>(savedDefaultSeconds);
  const [log, setLog] = useState<LogExcerpt>();
  const [logLoading, setLogLoading] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [comparison, setComparison] = useState<Comparison>();
  const [comparisonState, setComparisonState] = useState<"idle" | "loading" | "unavailable">("idle");
  const [investigation, setInvestigation] = useState<InvestigationSummary>();
  const [investigating, setInvestigating] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<number>();
  const [selectedStepNumber, setSelectedStepNumber] = useState<number>();
  const [query, setQuery] = useState("");
  const [logFocus, setLogFocusState] = useState(
    () => getWebviewState<{ logFocus?: boolean }>().logFocus ?? false,
  );
  const setLogFocus = (next: boolean) => {
    setLogFocusState(next);
    setWebviewState<{ logFocus?: boolean }>({ logFocus: next });
  };
  const [error, setError] = useState("");
  const inspectionGeneration = useRef(0);
  const logGeneration = useRef(0);
  const comparisonGeneration = useRef(0);
  const inspectionController = useRef<AbortController | undefined>(undefined);
  const logController = useRef<AbortController | undefined>(undefined);
  const logElement = useRef<HTMLPreElement>(null);
  const logKey = useRef("");
  const logScroll = useRef(new Map<string, number>());
  const autoActionRan = useRef(false);

  async function inspect(attempt?: number, preserveEvidence = false) {
    inspectionController.current?.abort();
    const controller = new AbortController();
    inspectionController.current = controller;
    const generation = ++inspectionGeneration.current;
    const switchingAttempt = attempt !== undefined && attempt !== inspection?.attempt;
    logGeneration.current++;
    logController.current?.abort();
    setError("");
    if (!preserveEvidence || switchingAttempt) {
      logScroll.current.clear();
      setLog(undefined);
      setLogLoading(false);
      setSelectedJobId(undefined);
      setSelectedStepNumber(undefined);
      setQuery("");
      setComparison(undefined);
      setComparisonState("idle");
    }
    try {
      const result = await bridge.request<InspectedRun>(
        "run.inspect",
        { runId, ...(attempt ? { attempt } : {}) },
        controller.signal,
      );
      if (generation !== inspectionGeneration.current) return;
      setInspection(result);
      if (!preserveEvidence || switchingAttempt) {
        const failedJob = result.jobs.find(isFailed);
        const targetJob = failedJob ?? result.jobs[0];
        if (targetJob) {
          const failedStep = failedJob?.steps.find(isFailed);
          void loadLog(targetJob.id, failedStep?.number, result);
        }
      }
    } catch (reason) {
      if (generation === inspectionGeneration.current && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  useEffect(() => {
    void inspect();
    return () => {
      inspectionGeneration.current++;
      logGeneration.current++;
      inspectionController.current?.abort();
      logController.current?.abort();
    };
  }, [runId]);

  const selection = useRef<{ jobId?: number; stepNumber?: number }>({});
  selection.current = {
    ...(selectedJobId === undefined ? {} : { jobId: selectedJobId }),
    ...(selectedStepNumber === undefined ? {} : { stepNumber: selectedStepNumber }),
  };

  // Background refresh only replaces the run's status, jobs and steps. It never interrupts a log the user
  // is reading; the selected log is reloaded once, when its job or step finishes.
  const latestInspection = useRef<InspectedRun | undefined>(undefined);
  latestInspection.current = inspection;
  const refreshKey = inspection && inspection.status !== "completed" && refreshSeconds > 0
    ? `${inspection.runId}:${inspection.attempt}:${inspection.status}:${refreshSeconds}`
    : undefined;
  useEffect(() => {
    if (!refreshKey || !latestInspection.current) return;
    const delay = refreshSeconds * 1_000;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, delay);
    };
    const refresh = async () => {
      const shown = latestInspection.current;
      if (!shown || inFlight) return;
      inFlight = true;
      const generation = inspectionGeneration.current;
      try {
        const next = await bridge.request<InspectedRun>("run.inspect", { runId: shown.runId, attempt: shown.attempt });
        if (cancelled) return;
        // A manual refresh or attempt switch in the meantime wins; the loop just carries on.
        if (generation === inspectionGeneration.current) {
          latestInspection.current = next;
          setInspection(next);
          const { jobId, stepNumber } = selection.current;
          if (
            jobId !== undefined &&
            selectionStatus(shown, jobId, stepNumber) !== "completed" &&
            selectionStatus(next, jobId, stepNumber) === "completed"
          ) {
            void loadLog(jobId, stepNumber, next);
          }
        }
      } catch {
        // A failed refresh is retried on the next tick; the manual refresh button reports errors.
      } finally {
        inFlight = false;
      }
      // A status change re-runs this effect (and cancels this loop); otherwise keep going at the same pace.
      schedule();
    };
    const tick = () => {
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void refresh();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshKey]);

  async function loadLog(jobId: number, stepNumber?: number, inspected = inspection) {
    if (!inspected) return;
    logController.current?.abort();
    const controller = new AbortController();
    logController.current = controller;
    const generation = ++logGeneration.current;
    setSelectedJobId(jobId);
    setSelectedStepNumber(stepNumber);
    setLog(undefined);
    setLogLoading(true);
    setError("");
    logKey.current = `${inspected.runId}:${inspected.attempt}:${jobId}:${stepNumber ?? "job"}`;
    try {
      const result = await bridge.request<LogExcerpt>(
        "run.logs.load",
        {
          runId: inspected.runId,
          attempt: inspected.attempt,
          jobId,
          ...(stepNumber === undefined ? {} : { stepNumber }),
        },
        controller.signal,
      );
      if (generation === logGeneration.current) setLog(result);
    } catch (reason) {
      if (generation === logGeneration.current && !controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generation === logGeneration.current) setLogLoading(false);
    }
  }

  const effectiveWorkflowId = inspection?.workflowId ?? workflowId;
  const effectiveRef = inspection?.ref ?? refName;

  useEffect(() => {
    if (!inspection || !effectiveWorkflowId || !effectiveRef || !isFailed(inspection)) {
      setComparison(undefined);
      setComparisonState("idle");
      return;
    }
    const generation = ++comparisonGeneration.current;
    setComparison(undefined);
    setComparisonState("loading");
    void bridge.request<HistoryResponse>("workflow.history.load", { workflowId: effectiveWorkflowId, page: 1 }, undefined)
      .then(async (history) => {
        const baseline = history.runs?.find((run) =>
          run.id !== inspection.runId &&
          run.branch === effectiveRef &&
          run.status === "completed" &&
          run.conclusion === "success",
        );
        if (!baseline) {
          if (generation === comparisonGeneration.current) setComparisonState("unavailable");
          return;
        }
        const baselineInspection = await bridge.request<InspectedRun>("run.inspect", { runId: baseline.id });
        if (generation === comparisonGeneration.current) {
          setComparison({ baseline: baselineInspection, baselineRunId: baseline.id });
          setComparisonState("idle");
        }
      })
      .catch(() => {
        if (generation === comparisonGeneration.current) setComparisonState("unavailable");
      });
    return () => { comparisonGeneration.current++; };
  }, [bridge, inspection?.runId, inspection?.attempt, effectiveWorkflowId, effectiveRef]);

  function explainFailure(jobId: number) {
    if (!inspection || effectiveWorkflowId === undefined || !effectiveRef) return;
    setInvestigating(true);
    setError("");
    void bridge
      .request<InvestigationSummary>("run.investigate", {
        workflowId: effectiveWorkflowId,
        runId: inspection.runId,
        attempt: inspection.attempt,
        jobId,
        ref: effectiveRef,
        presentation: "panel",
      })
      .then((summary) => {
        setInvestigation(summary);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setInvestigating(false);
      });
  }

  function investigateInChat(jobId: number) {
    if (!inspection || effectiveWorkflowId === undefined || !effectiveRef) return;
    const job = inspection.jobs.find((candidate) => candidate.id === jobId);
    const failedStep = job?.steps.find(
      (step) => step.conclusion === "failure" || step.conclusion === "timed_out",
    );
    setOpeningChat(true);
    setError("");
    void bridge
      .request("run.openChat", {
        workflowId: effectiveWorkflowId,
        runId: inspection.runId,
        attempt: inspection.attempt,
        jobId,
        ref: effectiveRef,
        ...(job ? { jobName: job.name } : {}),
        ...(failedStep ? { stepNumber: failedStep.number, stepName: failedStep.name } : {}),
        ...(inspection.workflowPath ? { workflowPath: inspection.workflowPath } : {}),
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setOpeningChat(false);
      });
  }

  function showInLog(jobId: number, text: string) {
    setQuery(text);
    if (selectedJobId !== jobId || !log || !READABLE_LOG_STATES.has(log.availability)) {
      void loadLog(jobId);
    }
  }

  useEffect(() => {
    if (!autoAction || autoActionRan.current || !inspection) return;
    const failed = inspection.jobs.find(
      (job) => job.conclusion === "failure" || job.conclusion === "timed_out",
    );
    if (!failed) return;
    autoActionRan.current = true;
    if (autoAction === "investigate") investigateInChat(failed.id);
    else explainFailure(failed.id);
  }, [inspection, autoAction]);

  useLayoutEffect(() => {
    if (logElement.current) {
      logElement.current.scrollTop = logScroll.current.get(logKey.current) ?? 0;
    }
  }, [log]);

  const jobTreeItems = useMemo<JobTreeJob[]>(
    () =>
      (inspection?.jobs ?? []).map((job) => {
        const jobStatus = normalizeStatus(job.status, job.conclusion);
        return {
          id: job.id,
          name: job.name,
          status: jobStatus,
          expanded: jobStatus === "failure" || selectedJobId === job.id,
          needs: job.needs,
          duration: elapsedLabel(job.startedAt, job.completedAt),
          steps: job.steps.map((step) => ({
            number: step.number,
            name: step.name,
            status: normalizeStatus(step.status, step.conclusion),
            duration: elapsedLabel(step.startedAt, step.completedAt),
          })),
        };
      }),
    [inspection?.jobs, selectedJobId],
  );

  const parsedLines = useMemo(() => {
    if (!log || !READABLE_LOG_STATES.has(log.availability)) return [];
    return parseLogLines(log.text);
  }, [log]);
  const firstErrorLine = useMemo(() => parsedLines.find((line) => line.kind === "error"), [parsedLines]);

  const logNoticeState = useMemo(() => {
    if (!log || READABLE_LOG_STATES.has(log.availability)) return null;
    const mapped = mapLogAvailabilityToDataState(log.availability, log.message, inspection?.htmlUrl);
    if (mapped) return mapped;
    return {
      kind: "empty" as const,
      title: "Log unavailable",
      detail: log.message ?? "GitHub did not provide a log for this selection.",
    };
  }, [log, inspection?.htmlUrl]);

  const activeFailedJob = inspection?.jobs.find(
    (job) => job.conclusion === "failure" || job.conclusion === "timed_out",
  );

  const selectedJob = inspection?.jobs.find((job) => job.id === selectedJobId);
  const selectedStep = selectedJob?.steps.find((step) => step.number === selectedStepNumber);
  const failedJob = inspection?.jobs.find(isFailed);
  const knownFailedStep = failedJob?.steps.find(isFailed);
  const comparisonJob = comparison?.baseline.jobs.find((job) => job.name === failedJob?.name);
  const divergence = failedJob && comparisonJob
    ? failedJob.steps.find((step, index) => {
        const baselineStep = comparisonJob.steps[index];
        return baselineStep?.name === step.name && baselineStep.conclusion !== step.conclusion;
      })
    : undefined;
  const safeInputs = (inspection?.dispatchInputs ?? []).filter((input) => !isSensitiveInputName(input.name));
  const inputDifferences = comparison ? safeInputs.flatMap((input) => {
    const other = comparison.baseline.dispatchInputs?.find((candidate) => candidate.name === input.name);
    if (!other || isSensitiveInputName(other.name) || other.value === input.value) return [];
    return [{ name: input.name, failed: input.value, baseline: other.value }];
  }) : [];
  const shortSha = inspection?.headSha ? inspection.headSha.slice(0, 7) : undefined;
  const runElapsed = inspection ? runDuration(inspection.jobs) : undefined;
  const actorDisplay = inspection?.isMyRun ? "you" : inspection?.actor;

  return (
    <section className="inspector" aria-label="Run inspector">
      {error ? (
        <StateNotice kind="stale" title="Could not load run" detail={error} inline />
      ) : null}

      {!inspection && !error ? (
        <StateNotice kind="loading" title="Loading run details…" />
      ) : null}

      {inspection ? (
        <>
          <div className="ad-inspector-head">
            <div className="ad-inspector-meta" role="toolbar" aria-label="Run metadata">
              <StatusLabel status={normalizeStatus(inspection.status, inspection.conclusion)} />
              <span className="ad-inspector-meta__title">{inspection.title}</span>
              {effectiveRef ? (
                <span className="ad-mono-sm ad-inspector-meta__ref" title={effectiveRef}>
                  {effectiveRef}
                  {shortSha ? ` @ ${shortSha}` : ""}
                </span>
              ) : null}
              {actorDisplay ? (
                <span className={inspection.isMyRun ? "ad-you" : undefined}>{actorDisplay}</span>
              ) : null}
              {formatRelativeTime(inspection.createdAt) ? <span>{formatRelativeTime(inspection.createdAt)}</span> : null}
              {runElapsed ? <span className="ad-num">{runElapsed}</span> : null}
            </div>

            <div className="ad-inspector-actions">
              {inspection.status !== "completed" ? (
                <>
                  <span className="ad-select ad-select--compact">
                    <select
                      aria-label="Auto-refresh interval"
                      title="How often this run refreshes while it is active"
                      value={refreshSeconds}
                      onChange={(event) => setRefreshSeconds(Number(event.target.value))}
                    >
                      {RUN_REFRESH_OPTIONS.map((seconds) => (
                        <option value={seconds} key={seconds}>
                          {`${refreshLabel(seconds)}${seconds === savedDefaultSeconds ? " (default)" : ""}`}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron-down" size={12} />
                  </span>
                  {refreshSeconds !== savedDefaultSeconds ? (
                    <Button
                      variant="ghost"
                      title="Use this interval for every run you open"
                      onClick={() => {
                        const seconds = normalizeRunRefreshSeconds(refreshSeconds);
                        void bridge.request<{ seconds: number }>("preferences.saveRunRefresh", { seconds })
                          .then(() => setSavedDefaultSeconds(seconds))
                          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
                      }}
                    >
                      Make default
                    </Button>
                  ) : null}
                </>
              ) : null}
              <span className="ad-select ad-select--compact">
                <select
                  aria-label="Run attempt"
                  value={inspection.attempt}
                  onChange={(event) => void inspect(Number(event.target.value))}
                >
                  {Array.from({ length: inspection.attemptCount }, (_, index) => index + 1).map(
                    (attempt) => (
                      <option value={attempt} key={attempt}>
                        {`Attempt ${attempt}`}
                      </option>
                    ),
                  )}
                </select>
                <Icon name="chevron-down" size={12} />
              </span>

              <RunActions
                bridge={bridge}
                runId={inspection.runId}
                attempt={inspection.attempt}
                status={inspection.status}
                conclusion={inspection.conclusion}
                onComplete={() => {
                  void inspect();
                  onActionComplete?.();
                }}
                {...(onRunWithSameInputs ? { onRunWithSameInputs: () => onRunWithSameInputs({
                  ...(effectiveRef ? { ref: effectiveRef } : {}),
                  ...(inspection.dispatchInputs !== undefined ? {
                    inputs: inspection.dispatchInputs.map((input) => ({
                      name: input.name,
                      value: isSensitiveInputName(input.name) ? "" : input.value,
                    })),
                  } : {}),
                }) } : {})}
              />

              {activeFailedJob && effectiveWorkflowId !== undefined && effectiveRef ? (
                <>
                  <CopilotAction
                    label="Explain failure"
                    busy={investigating}
                    onClick={() => explainFailure(activeFailedJob.id)}
                  />
                  <CopilotAction
                    label="Investigate in Copilot Chat"
                    busy={openingChat}
                    onClick={() => investigateInChat(activeFailedJob.id)}
                  />
                </>
              ) : null}

              {parseSupportedGitHubRunUrl(inspection.htmlUrl) ? (
                <Button
                  variant="ghost"
                  icon="link-external"
                  title="Open on GitHub"
                  onClick={() => {
                    void bridge.request("external.open", { url: inspection.htmlUrl }).catch((reason: unknown) => {
                      setError(reason instanceof Error ? reason.message : String(reason));
                    });
                  }}
                />
              ) : null}

              <Button
                variant="ghost"
                icon="refresh"
                title="Refresh run details"
                onClick={() => void inspect(inspection.attempt, true)}
              />
            </div>
          </div>

          {inspection.dispatchInputs && inspection.dispatchInputs.length > 0 ? (
            <details className="ad-run-inputs" open>
              <summary className="ad-section">{`Recorded inputs (${inspection.dispatchInputs.length})`}</summary>
              <dl className="ad-run-inputs__list" aria-label="Dispatch inputs">
                {inspection.dispatchInputs.map((input) => (
                  <div key={input.name} className="ad-run-inputs__item">
                    <dt className="ad-mono-sm ad-muted">{input.name}</dt>
                    <dd className="ad-mono-sm">
                      {isSensitiveInputName(input.name) ? <span className="ad-muted">(sensitive value hidden)</span> : input.value || <span className="ad-muted">(not set)</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}

          {inspection.attempt === inspection.attemptCount ? (
            <PendingApprovals
              bridge={bridge}
              runId={inspection.runId}
              workflowName={inspection.title}
              status={inspection.status}
              htmlUrl={inspection.htmlUrl}
              onReviewed={() => {
                void inspect(inspection.attempt, true);
                onActionComplete?.();
              }}
            />
          ) : null}

          <div
            className={`ad-inspector-split${logFocus && selectedJobId !== undefined ? " ad-grid-2--log-focus" : ""}`}
          >
            <button
              type="button"
              className="ad-steps-toggle"
              aria-expanded={stepsExpanded}
              aria-controls="run-inspector-steps"
              onClick={() => setStepsExpanded((current) => !current)}
            >
              <Icon name={stepsExpanded ? "chevron-down" : "chevron-right"} size={12} />
              <span>Steps{knownFailedStep ? ` · Failed at ${knownFailedStep.name}` : " · Failure step unidentified"}</span>
            </button>
            <div id="run-inspector-steps" className={`ad-inspector-tree${stepsExpanded ? " ad-inspector-tree--open" : ""}`}>
              <h3 className="ad-section">Jobs and steps</h3>
              {inspection.dependencyResolution !== "resolved" ? (
                <p className="ad-caption ad-muted">
                  Job dependencies could not be resolved from the run revision; showing the job list.
                </p>
              ) : null}
              {inspection.jobs.length === 0 ? (
                <StateNotice kind="empty" title="No jobs available (0 items)" detail="No jobs were reported for this attempt." inline />
              ) : (
                <JobTree
                  jobs={jobTreeItems}
                  activeJobId={selectedJobId}
                  activeStepNumber={selectedStepNumber}
                  onSelectJob={(jobId) => void loadLog(jobId)}
                  onSelectStep={(jobId, stepNumber) => void loadLog(jobId, stepNumber)}
                />
              )}
            </div>

            <div className="ad-inspector-log">
              <div className="ad-inspector-log__heading">
                <h3 className="ad-section">{selectedStep ? `Step log · ${selectedStep.name}` : selectedJob ? `Job log · ${selectedJob.name}` : "Job log"}</h3>
                {elapsedLabel(selectedStep?.startedAt, selectedStep?.completedAt) ?? elapsedLabel(selectedJob?.startedAt, selectedJob?.completedAt) ? (
                  <span className="ad-caption ad-muted ad-num">{elapsedLabel(selectedStep?.startedAt, selectedStep?.completedAt) ?? elapsedLabel(selectedJob?.startedAt, selectedJob?.completedAt)}</span>
                ) : null}
              </div>
              {firstErrorLine ? (
                <div className="ad-inspector-error-summary" role="status">
                  <Icon name="error" size={14} tone="failure" />
                  <span>{firstErrorLine.text}</span>
                </div>
              ) : null}
              {selectedJobId !== undefined ? (
                logLoading ? (
                  <StateNotice kind="loading" title={`Loading ${selectedStep ? selectedStep.name : selectedJob?.name ?? "job"} log…`} inline />
                ) : (
                  <div className="ad-log">
                    {log && READABLE_LOG_STATES.has(log.availability) ? (
                      <LogViewer
                        lines={parsedLines}
                        query={query}
                        onQueryChange={setQuery}
                        truncated={log.truncated}
                        canCopy
                        jumpToError
                        onCopy={() => {
                          void navigator.clipboard?.writeText(log.text).catch((reason: unknown) => {
                            setError(reason instanceof Error ? reason.message : String(reason));
                          });
                        }}
                        bodyRef={logElement}
                        expanded={logFocus}
                        onToggleExpand={() => setLogFocus(!logFocus)}
                        onScroll={(event) => logScroll.current.set(logKey.current, event.currentTarget.scrollTop)}
                      />
                    ) : (
                      <>
                        <div className="ad-log__bar"><span className="ad-toolbar__spacer" /><Button variant="ghost" icon="copy" disabled title="Copy log">Copy log</Button></div>
                        {log?.truncated ? (
                          <div className="ad-log__trunc" role="status"><Icon name="warning" size={14} tone="warning" /><span>Excerpt truncated at the 10,000-line / 2 MiB safe display limit.</span></div>
                        ) : null}
                        {logNoticeState ? <StateNotice state={logNoticeState} inline /> : (
                          <StateNotice kind="not_loaded" title="Log not loaded yet" detail="Select a job or step to load its bounded log." inline />
                        )}
                      </>
                    )}
                    {log?.stepBoundary === "unidentified" ? (
                      <p className="ad-log__boundary" role="status">Step boundaries could not be identified. Showing the bounded full-job context without attributing all lines to {selectedStep?.name ?? "a step"}.</p>
                    ) : null}
                  </div>
                )
              ) : (
                <StateNotice kind="not_loaded" title="Select a job" detail="Choose a job or step from the tree to inspect its bounded log." inline />
              )}

              {isFailed(inspection) ? (
                <section className="ad-run-compare" aria-label="Successful run comparison">
                  <h3 className="ad-section ad-run-compare__title">
                    <span>Compared with last green</span>
                    {comparison ? <span className="ad-mono-sm">#{comparison.baselineRunId}</span> : null}
                  </h3>
                  {comparisonState === "loading" ? <p className="ad-caption ad-muted" role="status">Finding a successful run on {effectiveRef}…</p> : null}
                  {comparisonState === "unavailable" ? (
                    <p className="ad-caption ad-muted">No successful run on the relevant ref is available for comparison. This does not establish that inputs or steps were unchanged.</p>
                  ) : null}
                  {comparison ? (
                    <>
                      <div className="ad-run-compare__panels">
                        <div>
                          <h4><Icon name="symbol-variable" size={14} tone="muted" />Inputs</h4>
                          {!inspection.dispatchInputs ? <p className="ad-caption ad-muted">Original inputs are unavailable for this run.</p> : !comparison.baseline.dispatchInputs ? <p className="ad-caption ad-muted">Baseline inputs are unavailable because GitHub does not return historical dispatch values.</p> : inputDifferences.length === 0 ? <p className="ad-caption ad-muted">No differences in the input values ActionDeck recorded for both runs.</p> : (
                            <dl className="ad-run-compare__diff">{inputDifferences.map((difference) => <div key={difference.name}><dt>{difference.name}</dt><dd><code className="ad-run-compare__chg">{difference.failed || "(not set)"}</code><span className="ad-muted">→ green had <code>{difference.baseline || "(not set)"}</code></span></dd></div>)}</dl>
                          )}
                          <h4><Icon name="split-horizontal" size={14} tone="muted" />Diverged at</h4>
                          <p className="ad-caption">{divergence ? <>Step <b>{divergence.name}</b>. Earlier steps matched in both runs.</> : <span className="ad-muted">Unavailable; matching step evidence was not present in both runs.</span>}</p>
                        </div>
                        <div>
                          <h4><Icon name="git-commit" size={14} tone="muted" />Commits and diff</h4>
                          <p className="ad-caption ad-muted">Commit-range details are unavailable in this inspector. Open the runs on GitHub to compare their revisions.</p>
                        </div>
                      </div>
                      <p className="ad-run-compare__note">The baseline is the latest successful run on {effectiveRef ?? "this ref"}; its creation time does not imply it preceded or followed this failure.</p>
                    </>
                  ) : null}
                </section>
              ) : null}

              {investigation ? (
                <FailureExplanation
                  explanation={investigation}
                  onShowInLog={activeFailedJob ? (text) => showInLog(activeFailedJob.id, text) : undefined}
                  onContinueInChat={activeFailedJob ? () => investigateInChat(activeFailedJob.id) : undefined}
                  onDismiss={() => setInvestigation(undefined)}
                />
              ) : null}
            </div>
          </div>

        </>
      ) : null}
    </section>
  );
}

function runDuration(jobs: InspectedRun["jobs"]): string | undefined {
  const starts = jobs.flatMap((job) => (job.startedAt ? [Date.parse(job.startedAt)] : [])).filter(Number.isFinite);
  const ends = jobs.flatMap((job) => (job.completedAt ? [Date.parse(job.completedAt)] : [])).filter(Number.isFinite);
  if (starts.length === 0 || ends.length !== jobs.length) return undefined;
  const elapsed = Math.max(...ends) - Math.min(...starts);
  return elapsed >= 0 ? formatDurationMs(elapsed) : undefined;
}
