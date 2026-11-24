import React, { useId } from "react";
import type { WorkflowEnvironmentRef } from "../../../src/domain/models/dispatch";
import { resolveAutoApprovalScope } from "../../../src/domain/services/auto-approval-scope";
import { Banner } from "./Banner";
import { Button } from "./Button";

/**
 * One-run opt-in to auto-approve the deployment gates of the run being dispatched. Renders nothing when
 * the workflow declares no environments, since there is nothing to approve.
 */
export function AutoApproveConsent({
  environments,
  inputs,
  checked,
  disabled = false,
  label = "this run",
  orgReadAccess,
  onGrantOrgAccess,
  onChange,
}: {
  environments: readonly WorkflowEnvironmentRef[] | undefined;
  inputs: Readonly<Record<string, string>>;
  checked: boolean;
  disabled?: boolean;
  label?: string;
  /** False when the GitHub token cannot read team membership; undefined when unknown. */
  orgReadAccess?: boolean | undefined;
  onGrantOrgAccess?: (() => void) | undefined;
  onChange(checked: boolean): void;
}): React.JSX.Element | null {
  const id = useId();
  if (!environments || environments.length === 0) return null;
  const scope = resolveAutoApprovalScope(environments, inputs);
  const covered = scope.environments === null
    ? "every environment gate it waits on"
    : scope.environments.join(", ");

  return (
    <div className="ad-field ad-autoapprove" aria-label="Auto-approval">
      <label className="ad-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>I understand the risks and agree to auto-approve deployment gates for {label}</span>
      </label>
      <span className="ad-field__help">
        Covers: <code>{covered}</code>
        {scope.unresolved.length > 0 ? ` (resolved at run time: ${scope.unresolved.join("; ")})` : null}
      </span>
      {checked ? (
        <Banner tone="warning" title={`ActionDeck will approve ${covered} for ${label} only`}>
          This skips the human review those environments require. It applies to the one run started here and
          never to later runs. GitHub still refuses the approval if the environment has Prevent self-review
          turned on or you are not one of its reviewers. Keep VS Code open until the run reaches the gate.
        </Banner>
      ) : null}
      {checked && orgReadAccess === false ? (
        <Banner tone="warning" title="Team reviewers may not be recognised">
          ActionDeck's GitHub sign-in lacks the read:org scope. If a team must review these environments, GitHub
          can report that you cannot approve them even though you are a member, and the auto-approval will not
          run. You will be notified if that happens.
          {onGrantOrgAccess ? (
            <>
              {" "}
              <Button variant="secondary" onClick={onGrantOrgAccess}>Grant team access (read:org)</Button>
            </>
          ) : null}
        </Banner>
      ) : null}
    </div>
  );
}
