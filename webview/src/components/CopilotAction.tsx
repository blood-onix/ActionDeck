import React from "react";
import { Button } from "./Button";

export interface CopilotActionProps {
  label?: string;
  available?: boolean;
  reason?: string | undefined;
  busy?: boolean;
  onClick?: (() => void) | undefined;
}

export function CopilotAction({
  label = "Ask Copilot",
  available = true,
  reason,
  busy = false,
  onClick,
}: CopilotActionProps): React.JSX.Element {
  if (!available) {
    return (
      <span className="ad-copilot--off">
        <Button variant="ghost" icon="sparkle" disabled>
          {label}
        </Button>
        <span className="ad-caption ad-muted" role="status">
          {reason ?? "Copilot is unavailable"}
        </span>
      </span>
    );
  }

  return (
    <Button variant="ghost" icon="sparkle" busy={busy} onClick={onClick}>
      {label}
    </Button>
  );
}
