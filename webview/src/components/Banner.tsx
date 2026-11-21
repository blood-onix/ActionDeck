import React from "react";
import { Icon, type Tone } from "./Icon";

export interface BannerProps {
  tone?: "warning" | "info" | "error";
  title: React.ReactNode;
  icon?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

const DEFAULT_ICON: Record<"warning" | "info" | "error", { name: string; tone: Tone }> = {
  warning: { name: "warning", tone: "warning" },
  info: { name: "info", tone: "running" },
  error: { name: "error", tone: "failure" },
};

export function Banner({
  tone = "info",
  title,
  icon,
  actions,
  children,
  className,
}: BannerProps): React.JSX.Element {
  const meta = DEFAULT_ICON[tone];
  const classes = ["ad-banner", `ad-banner--${tone}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role={tone === "error" ? "alert" : "status"}>
      <Icon name={icon ?? meta.name} size={16} tone={meta.tone} />
      <div className="ad-banner__body">
        <div className="ad-banner__title">{title}</div>
        {children ? <div className="ad-banner__text">{children}</div> : null}
      </div>
      {actions ? <div className="ad-banner__actions">{actions}</div> : null}
    </div>
  );
}
