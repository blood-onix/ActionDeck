import React from "react";
import { Icon } from "./Icon";
import { Button } from "./Button";

export interface ScheduleNoticeProps {
  state: "scheduled" | "missed";
  startsIn?: string | undefined;
  at?: string | undefined;
  busy?: boolean | undefined;
  onStartNow?: (() => void) | undefined;
  onCancelPlan?: (() => void) | undefined;
}

export function ScheduleNotice({
  state,
  startsIn,
  at,
  busy = false,
  onStartNow,
  onCancelPlan,
}: ScheduleNoticeProps): React.JSX.Element {
  if (state === "missed") {
    return (
      <div
        className="ad-sched ad-sched--missed"
        role="dialog"
        aria-modal="true"
        aria-label="Missed schedule"
      >
        <Icon name="history" size={16} tone="uncertain" />
        <div className="ad-sched__body">
          <div className="ad-notice__title">Missed schedule. Waiting for you</div>
          <div className="ad-notice__detail">
            {at
              ? `Scheduled start (${at}) elapsed while this VS Code window was closed. ActionDeck never auto-starts missed plans.`
              : "The scheduled time elapsed while this VS Code window was closed. ActionDeck never auto-starts missed plans."}
          </div>
        </div>
        <div className="ad-banner__actions">
          <Button variant="secondary" busy={busy} onClick={onCancelPlan}>
            Cancel plan
          </Button>
          <Button variant="primary" icon="play" busy={busy} onClick={onStartNow}>
            Start now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ad-sched" role="status">
      <span className="ad-pill ad-num">
        <Icon name="watch" size={14} tone="running" />
        <span>{startsIn ? `Starts in ${startsIn}` : "Scheduled"}</span>
      </span>
      <div className="ad-sched__body">
        <div className="ad-notice__title">
          {at ? `Scheduled for ${at}` : "Scheduled locally"}
        </div>
        <div className="ad-notice__detail">
          Scheduling lives in this VS Code window and will pause if the window closes before start.
        </div>
      </div>
      {onCancelPlan ? (
        <Button variant="secondary" busy={busy} onClick={onCancelPlan}>
          Cancel plan
        </Button>
      ) : null}
    </div>
  );
}
