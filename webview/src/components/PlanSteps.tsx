import React from "react";
import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import type { Status } from "../utils/status";

export interface PlanStepItem {
  name: string;
  workflow: string;
  ref?: string | undefined;
  status: Status | string;
  gate?: "on_success" | "on_any" | undefined;
  pauseBefore?: boolean | undefined;
  note?: string | undefined;
  /** GitHub run started for this step, once dispatched. */
  runId?: number | undefined;
  /** Opens the step: its run when dispatched, otherwise the workflow. */
  onOpen?: (() => void) | undefined;
  openLabel?: string | undefined;
  /** Step-level controls shown after the status, such as Cancel run. */
  actions?: React.ReactNode;
}

export interface PlanStepsProps {
  steps: readonly PlanStepItem[];
  still?: boolean | undefined;
}

export function PlanSteps({ steps, still = false }: PlanStepsProps): React.JSX.Element {
  return (
    <ol className="ad-plan">
      {steps.map((step, index) => {
        const details = (
          <>
          <div className="ad-plan__name">{step.name}</div>
          <div className="ad-caption ad-muted">
            <span className="ad-mono-sm">{step.workflow}</span>
            {step.ref ? (
              <>
                {" @ "}
                <span className="ad-mono-sm">{step.ref}</span>
              </>
            ) : null}
            {step.note ? ` · ${step.note}` : null}
          </div>
          </>
        );
        return (
        <React.Fragment key={`${step.workflow}:${index}`}>
          {index > 0 ? (
            <li className="ad-plan__gate" aria-hidden="false">
              <span className="ad-plan__rail" aria-hidden="true" />
              <span
                className={`ad-gate ${step.gate === "on_any" ? "ad-gate--any" : ""}`}
              >
                {step.gate === "on_any"
                  ? "Runs on any completion"
                  : "Runs only on success"}
              </span>
              {step.pauseBefore ? (
                <span className="ad-gate ad-gate--pause">
                  <Icon name="debug-pause" size={12} />
                  <span>Pause before</span>
                </span>
              ) : null}
            </li>
          ) : null}

          <li className={`ad-plan__step ad-plan__step--${step.status}`}>
            <span className="ad-plan__num ad-num">{index + 1}</span>
            {step.onOpen ? (
              <button
                type="button"
                className="ad-plan__main ad-plan__open"
                title={step.openLabel ?? `Open ${step.name}`}
                aria-label={step.openLabel ?? `Open ${step.name}`}
                onClick={step.onOpen}
              >
                {details}
              </button>
            ) : (
              <div className="ad-plan__main">{details}</div>
            )}
            <StatusLabel status={step.status} still={still} />
            {step.actions ? <span className="ad-plan__actions">{step.actions}</span> : null}
          </li>
        </React.Fragment>
        );
      })}
    </ol>
  );
}
