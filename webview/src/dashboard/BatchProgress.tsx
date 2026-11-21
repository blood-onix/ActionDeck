import type { BatchItemResult } from "../../../src/domain/models/batch";
import type { Bridge } from "../bridge";
import { Button } from "../components/Button";
import { StatusLabel } from "../components/StatusLabel";
import { DispatchTracker, type DispatchTrackerStage } from "../components/DispatchTracker";
import { normalizeStatus } from "../utils/status";

function mapBatchStateToStage(state: string): DispatchTrackerStage {
  if (state === "request_accepted" || state === "accepted") return "accepted";
  if (state === "associating") return "associating";
  if (state === "associated_run_found" || state === "completed" || state === "found") return "found";
  if (state === "outcome_uncertain" || state === "failed") return "uncertain";
  return "submitting";
}

export function BatchProgress({
  items,
  bridge,
  onInspectRun,
}: {
  items: readonly BatchItemResult[];
  bridge?: Bridge;
  onInspectRun?(runId: number): void;
}) {
  if (items.length === 0) return null;

  return (
    <section aria-label="Batch execution progress" className="batch-progress" style={{ marginTop: "var(--space-5)" }}>
      <h4 className="ad-section">Batch progress</h4>
      <div style={{ display: "grid", gap: "var(--space-4)" }}>
        {items.map((item) => (
          <div key={`${item.workflowId}:${item.ref}`} className="ad-card">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", marginBottom: "var(--space-3)" }}>
              <strong>{`Workflow #${item.workflowId}`}</strong>
              <span className="ad-mono-sm ad-muted">{item.ref}</span>
              <StatusLabel status={normalizeStatus(item.state, item.conclusion ?? null)} />
              <span className="ad-toolbar__spacer" />
              {item.runId !== undefined && onInspectRun ? (
                <Button variant="secondary" onClick={() => onInspectRun(item.runId!)}>
                  {`Inspect run #${item.runId}`}
                </Button>
              ) : null}
              {item.htmlUrl && bridge ? (
                <Button
                  variant="ghost"
                  icon="link-external"
                  onClick={() => void bridge.request("external.open", { url: item.htmlUrl })}
                >
                  Open on GitHub
                </Button>
              ) : null}
            </div>
            <DispatchTracker
              stage={mapBatchStateToStage(item.state)}
              detail={item.error ?? (item.conclusion ? `Conclusion: ${item.conclusion}` : undefined)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
