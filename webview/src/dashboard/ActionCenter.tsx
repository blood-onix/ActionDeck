import { useEffect, useRef, useState } from "react";
import type { DeploymentReviewItemResult, PendingEnvironment } from "../../../src/domain/models/approval";
import type { ReleasePlan } from "../../../src/domain/models/release-plan";
import type { Bridge } from "../bridge";
import { ApprovalCard } from "../components/ApprovalCard";
import { Button } from "../components/Button";
import { CopilotAction } from "../components/CopilotAction";
import { PlanSteps } from "../components/PlanSteps";
import { StateNotice } from "../components/StateNotice";
import { Icon } from "../components/Icon";
import { normalizeStatus } from "../utils/status";
import { planStepConnectors } from "../utils/plan-connectors";

export interface PendingRunInfo {
  runId: number;
  workflowName?: string;
  workflowId?: number;
  branch?: string;
}

interface ReviewOutcome {
  runId: number;
  item: DeploymentReviewItemResult;
}

interface PlanExplanation {
  mode: "model" | "fallback";
  observedFacts: string[];
  likelyExplanations: string[];
  suggestedNextSteps: string[];
  limitations: string[];
}

const BLOCKED_PLAN_STATES: ReadonlySet<ReleasePlan["state"]> = new Set([
  "blocked_uncertain",
  "missed_schedule",
  "stopped",
  "waiting_approval",
  "on_hold",
]);

export function ActionCenter({
  bridge,
  pendingRunIds,
  pendingRuns = [],
  queuedCount,
  approvalWaitCount,
  plans = [],
  onInspectRun,
  onExplainBlocked,
}: {
  bridge: Bridge;
  pendingRunIds: readonly number[];
  pendingRuns?: readonly PendingRunInfo[];
  queuedCount: number;
  approvalWaitCount: number;
  plans?: readonly ReleasePlan[];
  onInspectRun?(runId: number): void;
  onExplainBlocked?(plan: ReleasePlan): void;
  onClose?: () => void;
}) {
  const [chosenRunId, setSelectedRunId] = useState<number | undefined>(pendingRunIds[0]);
  // Pending runs often arrive after the drawer opens, so fall back to the first one instead of keeping
  // an empty selection while the picker visibly shows a run.
  const selectedRunId = chosenRunId !== undefined && pendingRunIds.includes(chosenRunId)
    ? chosenRunId
    : pendingRunIds[0];
  const [environmentsByRun, setEnvironmentsByRun] = useState<Record<number, PendingEnvironment[]>>({});
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [results, setResults] = useState<ReviewOutcome[]>([]);
  const [explanationsByPlan, setExplanationsByPlan] = useState<Record<string, PlanExplanation>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleExplainBlocked(plan: ReleasePlan) {
    if (onExplainBlocked) {
      onExplainBlocked(plan);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const explanation = await bridge.request<PlanExplanation>("plan.explainBlocked", {
        planId: plan.id,
      });
      setExplanationsByPlan((prev) => ({ ...prev, [plan.id]: explanation }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const runInfo = (runId: number) => pendingRuns.find((candidate) => candidate.runId === runId);
  const loadedRunIds = Object.keys(environmentsByRun).map(Number);

  async function loadRuns(runIds: readonly number[]) {
    if (runIds.length === 0) return;
    setBusy(true);
    setError("");
    const loaded: Record<number, PendingEnvironment[]> = {};
    const failures: string[] = [];
    for (const runId of runIds) {
      try {
        const response = await bridge.request<{ runId: number; environments: PendingEnvironment[] }>(
          "deployment.list",
          { runId },
        );
        loaded[runId] = response.environments;
      } catch (reason) {
        failures.push(`Run #${runId}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    setEnvironmentsByRun(loaded);
    setSelectedKeys([]);
    setResults([]);
    if (failures.length > 0) setError(failures.join(" "));
    setBusy(false);
  }

  // Show the approve/reject cards for the selected run right away, so a toast that lands here needs one click.
  const autoLoadedRunId = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (selectedRunId === undefined || autoLoadedRunId.current === selectedRunId) return;
    autoLoadedRunId.current = selectedRunId;
    void loadRuns([selectedRunId]);
    // loadRuns only reads the bridge, which is stable for the drawer's lifetime.
  }, [selectedRunId]);

  async function submitReview(state: "approved" | "rejected", keys: readonly string[]) {
    const byRun = new Map<number, number[]>();
    for (const key of keys) {
      const [runId, environmentId] = key.split(":").map(Number) as [number, number];
      byRun.set(runId, [...(byRun.get(runId) ?? []), environmentId]);
    }
    if (byRun.size === 0) return;
    setBusy(true);
    setError("");
    const outcomes: ReviewOutcome[] = [];
    for (const [runId, environmentIds] of byRun) {
      try {
        const response = await bridge.request<{ results: DeploymentReviewItemResult[] }>("deployment.review", {
          runId,
          environmentIds,
          state,
          comment,
        });
        outcomes.push(...response.results.map((item) => ({ runId, item })));
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        outcomes.push(
          ...environmentIds.map((environmentId) => ({
            runId,
            item: { environmentId, status: "failed" as const, error: message },
          })),
        );
      }
    }
    setResults(outcomes);
    setBusy(false);
  }

  const toggleKey = (key: string) =>
    setSelectedKeys((previous) =>
      previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key],
    );

  const attentionPlans = plans.filter((plan) => BLOCKED_PLAN_STATES.has(plan.state));

  return (
    <section aria-label="Action Center" className="action-center">
      <div className="ad-caption ad-muted" style={{ marginBottom: "var(--space-4)" }}>
        {`${approvalWaitCount} awaiting approval · ${queuedCount} queued`}
      </div>

      {error ? <StateNotice kind="stale" title="Action Center error" detail={error} inline /> : null}

      {attentionPlans.length > 0 ? (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <h4 className="ad-section">Plans needing attention</h4>
          <div style={{ display: "grid", gap: "var(--space-4)" }} aria-label="Plans needing attention">
            {attentionPlans.map((plan) => {
              const explanation = explanationsByPlan[plan.id];
              return (
                <div key={plan.id} className="ad-card">
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
                    <strong>{plan.name}</strong>
                    <span className="ad-caption ad-muted">
                      {plan.state.replaceAll("_", " ")}
                      {plan.blockedReason ? ` (${plan.blockedReason})` : ""}
                    </span>
                    <span className="ad-toolbar__spacer" />
                    <CopilotAction
                      label="Explain why this plan is blocked"
                      busy={busy}
                      onClick={() => void handleExplainBlocked(plan)}
                    />
                  </div>
                  <PlanSteps
                    steps={plan.steps.map((step, index) => ({
                      name: step.workflowPath.split("/").pop() ?? step.workflowPath,
                      workflow: step.workflowPath,
                      ref: step.ref,
                      status: normalizeStatus(step.state, step.conclusion ?? null),
                      ...planStepConnectors(plan.steps)[index],
                    }))}
                  />
                  {explanation ? (
                    <section
                      aria-label={`Plan explanation for ${plan.name}`}
                      className="ad-card"
                      style={{ marginTop: "var(--space-4)" }}
                    >
                      <h5 className="ad-section">
                        {`Plan explanation (${explanation.mode === "model" ? "Copilot" : "Evidence Summary"})`}
                      </h5>
                      <div className="ad-caption">
                        <strong>Observed facts</strong>
                        <ul>{explanation.observedFacts.map((item, index) => <li key={index}>{item}</li>)}</ul>
                        <strong>Likely explanations</strong>
                        <ul>{explanation.likelyExplanations.map((item, index) => <li key={index}>{item}</li>)}</ul>
                        <strong>Suggested next steps</strong>
                        <ul>{explanation.suggestedNextSteps.map((item, index) => <li key={index}>{item}</li>)}</ul>
                        {explanation.limitations.length > 0 ? (
                          <p className="ad-muted">{explanation.limitations.join(" ")}</p>
                        ) : null}
                      </div>
                    </section>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {pendingRunIds.length > 0 ? (
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          <span className="ad-select">
            <select
              aria-label="Run awaiting approval"
              value={selectedRunId ?? ""}
              onChange={(e) => setSelectedRunId(Number(e.target.value))}
            >
              {pendingRunIds.map((id) => {
                const info = runInfo(id);
                return (
                  <option key={id} value={id}>
                    {`Run #${id}${info?.workflowName ? ` · ${info.workflowName}` : ""}${info?.branch ? ` · ${info.branch}` : ""}`}
                  </option>
                );
              })}
            </select>
            <Icon name="chevron-down" size={12} />
          </span>
          <Button
            variant="secondary"
            busy={busy}
            disabled={selectedRunId === undefined}
            onClick={() => void loadRuns(selectedRunId === undefined ? [] : [selectedRunId])}
          >
            {selectedRunId !== undefined && environmentsByRun[selectedRunId] ? "Refresh" : "Load pending environments"}
          </Button>
          {pendingRunIds.length > 1 ? (
            <Button variant="secondary" busy={busy} onClick={() => void loadRuns(pendingRunIds)}>
              Load all pending runs
            </Button>
          ) : null}
          {selectedRunId !== undefined && onInspectRun ? (
            <Button variant="ghost" onClick={() => onInspectRun(selectedRunId)}>
              Inspect run
            </Button>
          ) : null}
        </div>
      ) : (
        <StateNotice kind="empty" title="No pending deployment approvals (0 items)" inline />
      )}

      {loadedRunIds.map((runId) => {
        const environments = environmentsByRun[runId] ?? [];
        const info = runInfo(runId);
        return (
          <div key={runId} aria-label={`Pending deployments for run ${runId}`} style={{ marginBottom: "var(--space-4)" }}>
            {environments.length === 0 ? (
              <StateNotice kind="empty" title={`No pending environments for run #${runId} (0 items)`} inline />
            ) : (
              <div style={{ display: "grid", gap: "var(--space-3)" }}>
                {environments.map((env) => {
                  const key = `${runId}:${env.environmentId}`;
                  return (
                    <div key={key} style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
                      {environments.length > 1 || loadedRunIds.length > 1 ? (
                        <input
                          type="checkbox"
                          style={{ marginTop: "var(--space-5)" }}
                          aria-label={`Select ${env.environmentName} on run #${runId}`}
                          disabled={!env.eligible}
                          checked={selectedKeys.includes(key)}
                          onChange={() => toggleKey(key)}
                        />
                      ) : null}
                      <div style={{ flex: "1 1 auto" }}>
                        <ApprovalCard
                          workflow={info?.workflowName ?? `Run #${runId}`}
                          run={runId}
                          environment={env.environmentName}
                          waiting={
                            env.waitTimerRemainingSeconds > 0
                              ? `${env.waitTimerRemainingSeconds}s remaining`
                              : "now"
                          }
                          eligible={env.eligible}
                          reason={env.reason}
                          reviewers={
                            env.requiredReviewers && env.requiredReviewers.length > 0
                              ? env.requiredReviewers.join(", ")
                              : undefined
                          }
                          busy={busy}
                          onApprove={() => void submitReview("approved", [key])}
                          onReject={() => void submitReview("rejected", [key])}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {loadedRunIds.some((runId) => (environmentsByRun[runId]?.length ?? 0) > 0) ? (
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "center", marginBottom: "var(--space-5)" }}>
          <input
            className="ad-input"
            style={{ flex: "1 1 200px" }}
            aria-label="Review comment"
            placeholder="Optional review comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {selectedKeys.length > 0 ? (
            <>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() => void submitReview("rejected", selectedKeys)}
              >
                {`Reject ${selectedKeys.length} deployments`}
              </Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => void submitReview("approved", selectedKeys)}
              >
                {`Approve ${selectedKeys.length} deployments`}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {results.length > 0 ? (
        <ul className="ad-kv" aria-label="Deployment review outcomes">
          {results.map((r, idx) => (
            <li key={`${r.runId}:${r.item.environmentId}:${idx}`}>
              <span>{`Run #${r.runId} · environment ${r.item.environmentId}`}</span>
              <span className="ad-caption ad-muted">
                {r.item.status}
                {r.item.error ? ` — ${r.item.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
