import React from "react";
import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import type { Status } from "../utils/status";

export interface PlanStepItem {
  name: string;
  workflow: string;
  ref?: string | undefined;
  status: Status | string;
  /** Condition for starting this step, set by the gates of the steps before it. */
  gate?: "on_success" | "on_any" | undefined;
  /** The gate refers to several parallel steps above. */
  afterGroup?: boolean | undefined;
  /** Starts at the same time as the step above. */
  startsTogether?: boolean | undefined;
  waitMinutes?: number | undefined;
  confirmBefore?: boolean | undefined;
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

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
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
              {step.startsTogether ? (
                <span className="ad-gate ad-gate--parallel">
                  <Icon name="split-horizontal" size={12} />
                  <span>Starts together with the step above</span>
                </span>
              ) : (
                <span
                  className={`ad-gate ${step.gate === "on_any" ? "ad-gate--any" : ""}`}
                >
                  {step.gate === "on_any"
                    ? step.afterGroup ? "Runs once all steps above finish" : "Runs whatever the result above"
                    : step.afterGroup ? "Runs only if all steps above succeed" : "Runs only if the step above succeeds"}
                </span>
              )}
              {step.waitMinutes ? (
                <span className="ad-gate ad-gate--pause">
                  <Icon name="watch" size={12} />
                  <span>{`Waits ${formatMinutes(step.waitMinutes)} first`}</span>
                </span>
              ) : null}
              {step.confirmBefore ? (
                <span className="ad-gate ad-gate--pause">
                  <Icon name="question" size={12} />
                  <span>Asks before starting</span>
                </span>
              ) : null}
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
