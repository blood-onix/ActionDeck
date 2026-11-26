import { useState } from "react";
import type { Bridge } from "../bridge";
import { Button } from "../components/Button";

type RunAction = "cancel" | "rerun_failed_jobs" | "rerun_all";
type RunActionResult =
  | { state: "accepted" }
  | { state: "outcome_uncertain"; reconciliation: "not_observed" | "unavailable" };

export function RunActions({
  bridge,
  runId,
  attempt,
  status,
  conclusion,
  onComplete,
  onRunWithSameInputs,
}: {
  bridge: Bridge;
  runId: number;
  attempt: number;
  status: string;
  conclusion: string | null;
  onComplete(): void;
  onRunWithSameInputs?(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canCancel = ["queued", "in_progress", "waiting", "pending"].includes(status);
  const isCompleted = status === "completed";
  const canRerunFailed =
    isCompleted && ["failure", "timed_out", "startup_failure"].includes(conclusion ?? "");

  async function submit(action: RunAction) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await bridge.request<RunActionResult>("run.action", {
        action,
        runId,
        attempt,
      });
      setMessage(
        result.state === "accepted"
          ? "GitHub accepted the run action."
          : "Outcome uncertain. Refresh and verify the run before taking another action.",
      );
      onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!canCancel && !isCompleted) return null;
  return (
    <div className="ad-drawer__actions" aria-label="Run actions">
      {canCancel ? (
        <Button
          variant="secondary"
          icon="debug-stop"
          busy={busy}
          title={`Cancel run #${runId} attempt ${attempt}`}
          onClick={() => void submit("cancel")}
        >
          {`Cancel run #${runId}`}
        </Button>
      ) : null}
      {isCompleted ? (
        <>
          {canRerunFailed ? (
            <Button
              variant="secondary"
              icon="refresh"
              busy={busy}
              title={`Rerun failed jobs for run #${runId} attempt ${attempt}`}
              onClick={() => void submit("rerun_failed_jobs")}
            >
              Re-run failed jobs
            </Button>
          ) : null}
          <Button
            variant="secondary"
            icon="debug-restart"
            busy={busy}
            title={`Rerun all jobs for run #${runId} attempt ${attempt}`}
            onClick={() => void submit("rerun_all")}
          >
            Re-run all jobs
          </Button>
          {onRunWithSameInputs ? (
            <Button variant="secondary" icon="copy" onClick={onRunWithSameInputs}>
              Re-run with same inputs
            </Button>
          ) : null}
        </>
      ) : null}
      {message ? (
        <span className="ad-caption ad-muted" role="status">
          {message}
        </span>
      ) : null}
      {error ? (
        <span className="ad-caption" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
