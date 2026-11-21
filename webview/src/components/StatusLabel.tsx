import React from "react";
import { Icon } from "./Icon";
import { normalizeStatus, STATUS_DESCRIPTORS, type Status } from "../utils/status";

export interface StatusLabelProps {
  status: Status | string;
  label?: string | undefined;
  chip?: boolean | undefined;
  iconOnly?: boolean | undefined;
  still?: boolean | undefined;
  className?: string | undefined;
}

export function StatusLabel({
  status,
  label,
  chip = false,
  iconOnly = false,
  still = false,
  className,
}: StatusLabelProps): React.JSX.Element {
  const resolved = normalizeStatus(status);
  const descriptor = STATUS_DESCRIPTORS[resolved];
  const text = label ?? descriptor.label;

  const classes = [
    "ad-status",
    chip ? "ad-status--chip" : "",
    iconOnly ? "ad-status--icon" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      data-tone={descriptor.tone}
      title={iconOnly ? text : undefined}
      aria-label={iconOnly ? text : undefined}
    >
      <Icon
        name={descriptor.codicon}
        size={14}
        tone={descriptor.tone}
        spin={Boolean(descriptor.spin) && !still}
      />
      {!iconOnly ? <span>{text}</span> : null}
    </span>
  );
}
