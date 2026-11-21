import React from "react";
import { Icon } from "./Icon";
import { mapWorkflowAvailability, type Availability } from "../utils/status";

export interface AvailabilityBadgeProps {
  value: Availability | string;
  title?: string | undefined;
  className?: string | undefined;
}

export function AvailabilityBadge({
  value,
  title,
  className,
}: AvailabilityBadgeProps): React.JSX.Element {
  const descriptor = mapWorkflowAvailability(value);
  const classes = [
    "ad-avail",
    descriptor.alert ? "ad-avail--alert" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} title={title ?? descriptor.label}>
      <Icon name={descriptor.codicon} size={12} tone={descriptor.tone} />
      <span>{descriptor.label}</span>
    </span>
  );
}
