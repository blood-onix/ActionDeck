import React, { useId } from "react";
import { Icon } from "./Icon";

export type ConflictKind = "type" | "choices" | "default";

export interface ConflictEntry {
  workflow: string;
  type: string;
  value: string;
}

export interface ConflictRowProps {
  input: string;
  kind: ConflictKind;
  entries: readonly ConflictEntry[];
  resolution?: "per_workflow" | "shared" | null | undefined;
  resolved?: boolean | undefined;
  onResolve?: ((resolution: "per_workflow" | "shared") => void) | undefined;
}

export function ConflictRow({
  input,
  kind,
  entries,
  resolution = null,
  resolved,
  onResolve,
}: ConflictRowProps): React.JSX.Element {
  const groupName = useId();
  const isResolved = resolved ?? resolution !== null;

  return (
    <div className={`ad-conflict ${isResolved ? "ad-conflict--resolved" : ""}`}>
      <div className="ad-conflict__head">
        <Icon
          name={isResolved ? "pass-filled" : "warning"}
          size={14}
          tone={isResolved ? "success" : "warning"}
        />
        <code className="ad-conflict__key ad-mono-sm">{input}</code>
        <span className="ad-caption ad-muted">
          {kind === "type"
            ? "Type conflict"
            : kind === "choices"
              ? "Choices mismatch"
              : "Different defaults"}
        </span>
      </div>

      <table className="ad-conflict__table ad-caption">
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.workflow}>
              <td className="ad-conflict__wf">{entry.workflow}</td>
              <td className="ad-mono-sm ad-muted">{entry.type}</td>
              <td className="ad-mono-sm">{entry.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div
        className="ad-conflict__resolve"
        role="radiogroup"
        aria-label={`Resolve conflict for ${input}`}
      >
        <label className="ad-radio">
          <input
            type="radio"
            name={groupName}
            checked={resolution === "per_workflow"}
            onChange={() => onResolve?.("per_workflow")}
          />
          <span>Keep a value per workflow</span>
        </label>

        {kind !== "type" ? (
          <label className="ad-radio">
            <input
              type="radio"
              name={groupName}
              checked={resolution === "shared"}
              onChange={() => onResolve?.("shared")}
            />
            <span>Use one value for all</span>
          </label>
        ) : null}
      </div>
    </div>
  );
}
