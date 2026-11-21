import { useState } from "react";
import type { ReleasePlan } from "../../../src/domain/models/release-plan";
import type { Bridge } from "../bridge";
import { Button } from "../components/Button";
import { CopilotAction } from "../components/CopilotAction";
import { PlanSteps, type PlanStepItem } from "../components/PlanSteps";
import { ScheduleNotice } from "../components/ScheduleNotice";
import { StateNotice } from "../components/StateNotice";
import { StatusLabel } from "../components/StatusLabel";
import { normalizeStatus } from "../utils/status";

interface PlanExplanation {
  mode: "model" | "fallback";
  observedFacts: string[];
  likelyExplanations: string[];
  suggestedNextSteps: string[];
  limitations: string[];
}

const CANCELLABLE_STEP_STATES = new Set(["request_accepted", "running", "waiting_approval"]);

type RunActionResult =
  | { state: "accepted" }
  | { state: "outcome_uncertain"; reconciliation: "not_observed" | "unavailable" };

/** Cancels the GitHub run of an in-flight plan step; asks for a second click to confirm. */
function CancelStepRun({ bridge, runId }: { bridge: Bridge; runId: number }) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  const [error, setError] = useState("");

  async function cancel() {
    setPhase("busy");
    setError("");
    try {
      // Plan steps dispatch a fresh run, so the first attempt is the one in flight; the host rejects a stale attempt.
      const result = await bridge.request<RunActionResult>("run.action", { action: "cancel", runId, attempt: 1 });
      setPhase("done");
      if (result.state !== "accepted") setError("Outcome uncertain. Open the run to verify it stopped.");
    } catch (reason) {
      setPhase("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <>
      {phase === "done" ? (
        <span className="ad-caption ad-muted" role="status">Cancel requested</span>
      ) : phase === "confirm" ? (
        <>
          <Button variant="secondary" icon="debug-stop" onClick={() => void cancel()}>
            {`Confirm cancel #${runId}`}
          </Button>
          <Button variant="ghost" onClick={() => setPhase("idle")}>Keep running</Button>
        </>
      ) : (
        <Button
          variant="secondary"
          icon="debug-stop"
          busy={phase === "busy"}
          title={`Cancel GitHub run #${runId}`}
          onClick={() => setPhase("confirm")}
        >
          Cancel run
        </Button>
      )}
      {error ? <span className="ad-caption" role="alert">{error}</span> : null}
    </>
  );
}

export function ReleasePlanProgress({
  bridge,
  plan,
  onPlanUpdated,
  onExplainBlocked,
  onInspectRun,
  onOpenWorkflow,
  onDismiss,
}: {
  bridge: Bridge;
  plan: ReleasePlan;
  onPlanUpdated(plan: ReleasePlan): void;
  onExplainBlocked?(plan: ReleasePlan): void;
  /** Opens a dispatched step's run in the Run Inspector. */
  onInspectRun?(runId: number): void;
  /** Opens a step's workflow when it has no run yet. */
  onOpenWorkflow?(workflowPath: string): void;
  /** Hides a finished plan from the deck. */
  onDismiss?(): void;
}) {
  const [reEntryInputs, setReEntryInputs] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explanation, setExplanation] = useState<PlanExplanation>();

  async function explainBlocked() {
    if (onExplainBlocked) {
      onExplainBlocked(plan);
      return;
    }
    setBusy(true);
    setError("");
    try {
      setExplanation(
        await bridge.request<PlanExplanation>("plan.explainBlocked", { planId: plan.id }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function control(operation: "plan.start" | "plan.pause" | "plan.resume" | "plan.stop") {
    setBusy(true);
    setError("");
    try {
      const updated = await bridge.request<ReleasePlan>(operation, {
        planId: plan.id,
        ...(operation === "plan.start" || operation === "plan.resume"
          ? { runtimeInputs: reEntryInputs }
          : {}),
      });
      onPlanUpdated(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const stepItems: PlanStepItem[] = plan.steps.map((step) => ({
    name: step.workflowPath.split("/").pop() ?? step.workflowPath,
    workflow: step.workflowPath,
    ref: step.ref,
    status: normalizeStatus(step.state, step.conclusion ?? null),
    gate: step.gate === "on_any_completion" ? "on_any" : "on_success",
    pauseBefore: (step.reEntryRequiredKeys?.length ?? 0) > 0,
    ...(step.conclusion ? { note: step.conclusion } : {}),
    ...(step.runId !== undefined ? { runId: step.runId } : {}),
    ...(step.runId !== undefined && onInspectRun
      ? { onOpen: () => onInspectRun(step.runId!), openLabel: `Open run #${step.runId}` }
      : onOpenWorkflow
      ? { onOpen: () => onOpenWorkflow(step.workflowPath), openLabel: `Open ${step.workflowPath}` }
      : {}),
    ...(step.runId !== undefined && CANCELLABLE_STEP_STATES.has(step.state)
      ? { actions: <CancelStepRun key={step.runId} bridge={bridge} runId={step.runId} /> }
      : {}),
  }));

  const scheduleAtLabel = plan.schedule
    ? `${new Date(plan.schedule.runAtMs).toLocaleString()} (${plan.schedule.timeZone})`
    : undefined;

  return (
    <section
      aria-label="Release Plan Progress"
      className="ad-card"
      style={{ margin: "var(--space-3) var(--space-5)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", marginBottom: "var(--space-3)" }}>
        <strong>{plan.name}</strong>
        <StatusLabel status={normalizeStatus(plan.state)} />
        <span className="ad-toolbar__spacer" />
        {(plan.state === "draft" || plan.state === "scheduled") ? (
          <Button variant="primary" icon="play" busy={busy} onClick={() => void control("plan.start")}>
            Start plan
          </Button>
        ) : null}
        {plan.state === "running" ? (
          <Button variant="secondary" icon="debug-pause" busy={busy} onClick={() => void control("plan.pause")}>
            Pause plan
          </Button>
        ) : null}
        {plan.state === "paused" ? (
          <Button variant="primary" icon="play" busy={busy} onClick={() => void control("plan.resume")}>
            Resume plan
          </Button>
        ) : null}
        {(plan.state === "running" ||
          plan.state === "paused" ||
          plan.state === "waiting_approval" ||
          plan.state === "missed_schedule") ? (
          <Button
            variant="secondary"
            busy={busy}
            title="Don't start any more steps. A run already in progress keeps running; cancel it on its step."
            onClick={() => void control("plan.stop")}
          >
            Stop future steps
          </Button>
        ) : null}
        {onDismiss ? (
          <Button variant="ghost" icon="close" title="Hide this finished plan" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
        {(plan.state === "blocked_uncertain" ||
          plan.state === "waiting_approval" ||
          plan.state === "stopped" ||
          plan.state === "paused" ||
          plan.state === "missed_schedule") ? (
          <CopilotAction
            label="Explain why this plan is blocked"
            busy={busy}
            onClick={() => void explainBlocked()}
          />
        ) : null}
      </div>

      {error ? <StateNotice kind="stale" title="Plan action failed" detail={error} inline /> : null}
      {plan.blockedReason ? (
        <p className="ad-caption ad-muted" role="status">
          {plan.blockedReason}
        </p>
      ) : null}

      {plan.state === "missed_schedule" ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <ScheduleNotice
            state="missed"
            at={scheduleAtLabel}
            busy={busy}
            onStartNow={() => void control("plan.resume")}
            onCancelPlan={() => void control("plan.stop")}
          />
        </div>
      ) : plan.state === "scheduled" && plan.schedule ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <ScheduleNotice state="scheduled" at={scheduleAtLabel} />
        </div>
      ) : null}

      <PlanSteps steps={stepItems} />

      {plan.steps.some((s) => (s.reEntryRequiredKeys?.length ?? 0) > 0) ? (
        <div style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
          {plan.steps.flatMap((step) =>
            (step.reEntryRequiredKeys ?? []).map((key) => (
              <label key={`${step.id}:${key}`} className="ad-field">
                <span className="ad-caption">{`Re-enter sensitive input ${key} for ${step.workflowPath}`}</span>
                <input
                  className="ad-input"
                  type="password"
                  value={reEntryInputs[step.id]?.[key] ?? ""}
                  onChange={(e) =>
                    setReEntryInputs((prev) => ({
                      ...prev,
                      [step.id]: { ...(prev[step.id] ?? {}), [key]: e.target.value },
                    }))
                  }
                />
              </label>
            )),
          )}
        </div>
      ) : null}

      {explanation ? (
        <section aria-label="Plan explanation" className="ad-card" style={{ marginTop: "var(--space-4)" }}>
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
              <ul>{explanation.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}
