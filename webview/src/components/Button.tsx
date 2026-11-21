import React from "react";
import { Icon } from "./Icon";

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onClick"> {
  variant?: "primary" | "secondary" | "ghost";
  icon?: string | undefined;
  title?: string | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  pressed?: boolean | undefined;
  kbd?: string | undefined;
  onClick?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined;
  children?: React.ReactNode;
}

export function Button({
  variant = "secondary",
  icon,
  title,
  disabled = false,
  busy = false,
  pressed,
  kbd,
  onClick,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps): React.JSX.Element {
  const isIconOnly = children === undefined || children === null || children === false;
  const classes = [
    "ad-btn",
    variant === "primary" ? "ad-btn--primary" : "",
    variant === "ghost" ? "ad-btn--ghost" : "",
    isIconOnly ? "ad-btn--icon" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const resolvedIcon = busy ? "sync" : icon;

  return (
    <button
      type={type}
      className={classes}
      title={title}
      aria-label={rest["aria-label"] ?? (isIconOnly ? title : undefined)}
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
      aria-pressed={pressed !== undefined ? pressed : undefined}
      onClick={onClick}
      {...rest}
    >
      {resolvedIcon ? <Icon name={resolvedIcon} size={14} spin={busy} /> : null}
      {!isIconOnly ? <span>{children}</span> : null}
      {kbd ? <kbd className="ad-kbd">{kbd}</kbd> : null}
    </button>
  );
}
