import React from "react";

export type Tone =
  | "success"
  | "failure"
  | "warning"
  | "running"
  | "restricted"
  | "uncertain"
  | "muted";

export interface IconProps {
  name: string;
  size?: 12 | 14 | 16;
  tone?: Tone;
  spin?: boolean;
  label?: string;
  className?: string;
}

export function Icon({
  name,
  size = 16,
  tone,
  spin = false,
  label,
  className,
}: IconProps): React.JSX.Element {
  const classes = [
    "ad-icon",
    `ad-icon--${size}`,
    "codicon",
    `codicon-${name}`,
    tone ? `ad-tone-${tone}` : "",
    spin ? "ad-spin" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (label) {
    return <span className={classes} role="img" aria-label={label} title={label} />;
  }

  return <span className={classes} aria-hidden="true" />;
}
