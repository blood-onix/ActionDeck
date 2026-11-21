import React from "react";
import { Icon } from "./Icon";

export interface ToggleChipProps {
  pressed?: boolean;
  icon?: string;
  count?: number;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function ToggleChip({
  pressed = false,
  icon,
  count,
  onClick,
  children,
  className,
}: ToggleChipProps): React.JSX.Element {
  const classes = ["ad-chip", pressed ? "ad-chip--on" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <span>{children}</span>
      {count !== undefined ? <span className="ad-badge">{count}</span> : null}
    </button>
  );
}
