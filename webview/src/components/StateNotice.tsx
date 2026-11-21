import React from "react";
import { Icon, type Tone } from "./Icon";
import type { DataState, DataStateKind } from "../utils/data-state";

export type StateNoticeKind = DataStateKind | "rate_limited";

export interface StateNoticeProps {
  kind?: StateNoticeKind | undefined;
  state?: DataState | undefined;
  title?: string | undefined;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  inline?: boolean | undefined;
  className?: string | undefined;
}

const DEFAULT_META: Record<StateNoticeKind, { icon: string; tone: Tone; title: string }> = {
  not_loaded: { icon: "circle-small", tone: "muted", title: "Not loaded yet" },
  loading: { icon: "sync", tone: "running", title: "Loading…" },
  empty: { icon: "inbox", tone: "muted", title: "No items (0 items)" },
  stale: { icon: "warning", tone: "warning", title: "Showing stale data" },
  rate_limited: { icon: "warning", tone: "warning", title: "Rate limited" },
  restricted: { icon: "lock", tone: "restricted", title: "Permission restricted" },
  sso: { icon: "shield", tone: "restricted", title: "SSO authorization required" },
  expired: { icon: "history", tone: "muted", title: "Logs expired" },
  in_progress: { icon: "sync", tone: "running", title: "Logs in progress" },
  uncertain: { icon: "question", tone: "uncertain", title: "Outcome uncertain" },
};

export function StateNotice({
  kind,
  state,
  title,
  detail,
  action,
  inline = false,
  className,
}: StateNoticeProps): React.JSX.Element {
  const resolvedKind: StateNoticeKind = kind ?? state?.kind ?? "empty";
  const normalizedClassKind = resolvedKind === "rate_limited" ? "stale" : resolvedKind;
  const meta = DEFAULT_META[resolvedKind];

  const resolvedTitle =
    title ??
    (state && "title" in state ? state.title : undefined) ??
    (state && state.kind === "loading" ? state.label : undefined) ??
    meta.title;

  const resolvedDetail =
    detail ??
    (state && "detail" in state ? state.detail : undefined) ??
    (state && state.kind === "restricted" ? state.missingScopeOrReason : undefined);

  if (resolvedKind === "loading") {
    const bars = state && state.kind === "loading" && state.bars ? state.bars : [80, 64, 72];
    return (
      <div
        className={[
          "ad-notice",
          "ad-notice--loading",
          inline ? "ad-notice--inline" : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="status"
      >
        <span className="ad-sr">{resolvedTitle}</span>
        {bars.map((width, index) => (
          <span key={index} className="ad-skel" style={{ width: `${width}%` }} aria-hidden="true" />
        ))}
      </div>
    );
  }

  const classes = [
    "ad-notice",
    `ad-notice--${normalizedClassKind}`,
    inline ? "ad-notice--inline" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="status">
      <Icon name={meta.icon} size={16} tone={meta.tone} />
      <div>
        <div className="ad-notice__title">{resolvedTitle}</div>
        {resolvedDetail ? <div className="ad-notice__detail">{resolvedDetail}</div> : null}
      </div>
      {action ? <div className="ad-notice__action">{action}</div> : null}
    </div>
  );
}
