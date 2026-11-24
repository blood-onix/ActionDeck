import { useEffect, useState } from "react";
import type { Bridge } from "../bridge";
import type { DeploymentReviewItemResult, PendingEnvironment } from "../../../src/domain/models/approval";
import { ApprovalCard } from "../components/ApprovalCard";
import { Button } from "../components/Button";

/**
 * Deployment gates the inspected run waits on, with Approve / Reject when GitHub lets this account review
 * them and the reason (plus a GitHub link) when it does not.
 */
export function PendingApprovals({
  bridge,
  runId,
  workflowName,
  status,
  htmlUrl,
  onReviewed,
}: {
  bridge: Bridge;
  runId: number;
  workflowName: string;
  status: string;
  htmlUrl: string;
  onReviewed?: () => void;
}): React.JSX.Element | null {
  const [environments, setEnvironments] = useState<PendingEnvironment[]>([]);
  const [busyId, setBusyId] = useState<number>();
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const waiting = status === "waiting";

  useEffect(() => {
    if (!waiting) {
      setEnvironments([]);
      return;
    }
    let cancelled = false;
    void bridge
      .request<{ runId: number; environments: PendingEnvironment[] }>("deployment.list", { runId })
      .then((response) => {
        if (cancelled) return;
        setEnvironments(response.environments);
        setError("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, runId, waiting, reloadKey]);

  async function review(environmentId: number, state: "approved" | "rejected") {
    setBusyId(environmentId);
    setError("");
    try {
      const { results: [result] } = await bridge.request<{ results: DeploymentReviewItemResult[] }>("deployment.review", {
        runId,
        environmentIds: [environmentId],
        state,
      });
      if (result && result.status !== "succeeded") {
        setError(result.error ?? `Review ${result.status.replace("_", " ")}.`);
      }
      setReloadKey((key) => key + 1);
      onReviewed?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  if (!waiting || (environments.length === 0 && !error)) return null;
  const blocked = environments.some((env) => !env.currentUserCanApprove);

  return (
    <section className="ad-run-approvals" aria-label="Pending deployment approvals">
      <h3 className="ad-section">{`Pending approvals (${environments.length})`}</h3>
      {environments.map((env) => (
        <ApprovalCard
          key={env.environmentId}
          workflow={workflowName}
          run={runId}
          environment={env.environmentName}
          waiting="for review"
          eligible={env.eligible}
          reason={env.reason}
          reviewers={env.requiredReviewers?.join(", ")}
          busy={busyId === env.environmentId}
          onApprove={() => void review(env.environmentId, "approved")}
          onReject={() => void review(env.environmentId, "rejected")}
        />
      ))}
      {blocked ? (
        <p className="ad-caption ad-muted" role="note">
          GitHub reports the signed-in account cannot approve this gate, so ActionDeck cannot approve it or
          auto-approve it. If you can approve it on GitHub, the VS Code token may lack the read:org scope
          needed for team reviewers; see the ActionDeck output channel.{" "}
          <Button
            variant="ghost"
            icon="link-external"
            title="Review on GitHub"
            onClick={() => {
              void bridge.request("external.open", { url: htmlUrl }).catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason));
              });
            }}
          >
            Review on GitHub
          </Button>
        </p>
      ) : null}
      {error ? (
        <p className="ad-caption" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
