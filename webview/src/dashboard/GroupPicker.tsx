import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { StateNotice } from "../components/StateNotice";

/** Puts the selected workflows into a group, or returns them to their default (@folder comment or prefix rule). */
export function GroupPicker({
  count,
  existingGroups,
  busy,
  error,
  onApply,
  onClose,
}: {
  count: number;
  existingGroups: readonly string[];
  busy: boolean;
  error?: string | undefined;
  onApply(group: string | null): void;
  onClose(): void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const trimmed = name.trim();
  const noun = count === 1 ? "workflow" : "workflows";

  return (
    <section
      aria-label="Group selected workflows"
      className="ad-card ad-popcard"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <strong>{`Group ${count} selected ${noun}`}</strong>
      <form
        className="ad-popcard__row"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onApply(trimmed);
        }}
      >
        <label className="ad-field" style={{ flex: "1 1 240px" }}>
          <span className="ad-caption">Group name</span>
          <input
            ref={inputRef}
            className="ad-input"
            value={name}
            maxLength={128}
            placeholder="e.g. Terraform/Core"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" busy={busy} disabled={!trimmed}>
          Move to group
        </Button>
      </form>
      {existingGroups.length > 0 ? (
        <div className="ad-popcard__chips" aria-label="Existing groups">
          {existingGroups.map((group) => (
            <Button key={group} variant="secondary" disabled={busy} onClick={() => onApply(group)}>
              {group}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="ad-caption ad-muted">
        Groups are saved for you in this repository and don't change workflow files. Use “/” for nested names.
      </p>
      {error ? <StateNotice kind="stale" title="Could not change the group" detail={error} inline /> : null}
      <div className="ad-popcard__row">
        <Button
          variant="ghost"
          disabled={busy}
          title="Use the @folder comment or prefix rule again"
          onClick={() => onApply(null)}
        >
          Reset to default group
        </Button>
        <span className="ad-toolbar__spacer" />
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
