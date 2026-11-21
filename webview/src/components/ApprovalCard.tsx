import React from "react";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { StatusLabel } from "./StatusLabel";

export interface ApprovalCardProps {
  workflow: string;
  run: number;
  environment: string;
  waiting: string;
  actor?: string | undefined;
  mine?: boolean | undefined;
  eligible?: boolean | undefined;
  reason?: string | undefined;
  reviewers?: string | undefined;
  autoRule?: boolean | undefined;
  busy?: boolean | undefined;
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
}

export function ApprovalCard({
  workflow,
  run,
  environment,
  waiting,
  actor,
  mine = false,
  eligible = true,
  reason,
  reviewers,
  autoRule = false,
  busy = false,
  onApprove,
  onReject,
}: ApprovalCardProps): React.JSX.Element {
  return (
    <article className="ad-card" aria-label={`${workflow} #${run} ${environment}`}>
      <div className="ad-approval__head">
        <StatusLabel status="waiting_approval" iconOnly />
        <div className="ad-approval__titles">
          <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
            <strong>{workflow}</strong>
            <span className="ad-mono-sm ad-muted">{`#${run}`}</span>
            <span className="ad-env">
              <Icon name="globe" size={12} tone="muted" />
              <span>{environment}</span>
            </span>
            {autoRule ? (
              <span className="ad-avail">
                <Icon name="shield" size={12} tone="muted" />
                <span>Auto-rule</span>
              </span>
            ) : null}
          </div>
          <div className="ad-caption ad-muted">
            <span>{`Waiting ${waiting}`}</span>
            {actor || mine ? (
              <>
                {" · "}
                <span className={mine ? "ad-you" : undefined}>
                  {mine ? "you" : actor}
                </span>
              </>
            ) : null}
            {reviewers ? ` · Reviewers: ${reviewers}` : null}
          </div>
        </div>
      </div>

      <div className="ad-approval__foot">
        <Button
          variant="secondary"
          busy={busy}
          disabled={!eligible}
          title={`Reject ${environment} on #${run}`}
          onClick={onReject}
        >
          Reject
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!eligible}
          title={`Approve ${environment} on #${run}`}
          onClick={onApprove}
        >
          Approve
        </Button>
        {!eligible && reason ? (
          <span className="ad-approval__why ad-caption ad-muted" role="status">
            <Icon name="lock" size={12} tone="restricted" />
            <span>{reason}</span>
          </span>
        ) : null}
      </div>
    </article>
  );
}
