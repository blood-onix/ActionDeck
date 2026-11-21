import React from "react";
import { Icon } from "./Icon";

export type DispatchTrackerStage =
  | "submitting"
  | "accepted"
  | "associating"
  | "found"
  | "uncertain";

export interface DispatchTrackerProps {
  stage: DispatchTrackerStage;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
  still?: boolean | undefined;
}

const STAGE_ORDER: Record<DispatchTrackerStage, number> = {
  submitting: 0,
  accepted: 1,
  associating: 2,
  found: 3,
  uncertain: 3,
};

export function DispatchTracker({
  stage,
  detail,
  actions,
  still = false,
}: DispatchTrackerProps): React.JSX.Element {
  const currentIdx = STAGE_ORDER[stage];
  const isUncertain = stage === "uncertain";

  const steps: Array<{ key: string; label: string; idx: number }> = [
    { key: "submitting", label: "Submitting", idx: 0 },
    { key: "accepted", label: "Request accepted", idx: 1 },
    { key: "associating", label: "Associating run", idx: 2 },
    {
      key: isUncertain ? "uncertain" : "found",
      label: isUncertain ? "Outcome uncertain" : "Run found",
      idx: 3,
    },
  ];

  return (
    <div
      className={`ad-track ${isUncertain ? "ad-track--uncertain" : ""}`}
      role="status"
      aria-label="Dispatch progress"
    >
      <ol className="ad-track__steps">
        {steps.map((step) => {
          const done = step.idx < currentIdx || (stage === "found" && step.idx === 3);
          const active = step.idx === currentIdx && stage !== "found" && !isUncertain;
          const uncertainStep = isUncertain && step.idx === 3;

          const stepClass = [
            "ad-track__step",
            done ? "ad-track__step--done" : "",
            active ? "ad-track__step--active" : "",
            uncertainStep ? "ad-track__step--uncertain" : "",
          ]
            .filter(Boolean)
            .join(" ");

          let iconName = "circle-large-outline";
          let tone: "success" | "running" | "uncertain" | "muted" = "muted";
          let spin = false;

          if (uncertainStep) {
            iconName = "question";
            tone = "uncertain";
          } else if (done) {
            iconName = "pass-filled";
            tone = "success";
          } else if (active) {
            iconName = "sync";
            tone = "running";
            spin = !still;
          }

          return (
            <li key={step.key} className={stepClass}>
              <Icon name={iconName} size={14} tone={tone} spin={spin} />
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>

      {detail ? <div className="ad-track__detail">{detail}</div> : null}
      {actions ? <div className="ad-track__actions">{actions}</div> : null}
    </div>
  );
}
