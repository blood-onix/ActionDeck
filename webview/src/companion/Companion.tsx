import { useEffect, useMemo, useState } from "react";
import type { DispatchInputDefinition, WorkflowEnvironmentRef } from "../../../src/domain/models/dispatch";
import type { WorkflowRunRecord } from "../../../src/domain/models/run";
import type { AutoApprovalScope } from "../../../src/domain/services/auto-approval-scope";
import { isSensitiveInputName } from "../../../src/domain/services/plan-transitions";
import type { Bridge } from "../bridge";
import { Banner } from "../components/Banner";
import { AutoApproveConsent } from "../components/AutoApproveConsent";
import { BranchRefInput, useRemoteBranches } from "../components/BranchRefInput";
import { Button } from "../components/Button";
import { CopilotAction } from "../components/CopilotAction";
import { DispatchField } from "../components/DispatchField";
import { DispatchTracker, type DispatchTrackerStage } from "../components/DispatchTracker";
import { StateNotice } from "../components/StateNotice";
import { StatusLabel } from "../components/StatusLabel";
import { Icon } from "../components/Icon";
import { normalizeStatus } from "../utils/status";

interface LocalPreview {
  workflowPath: string;
  dispatchable: boolean;
  diagnostic?: string;
  inputs?: readonly DispatchInputDefinition[];
  warning: string;
}

interface DispatchValidation {
  target: {
    state: "available" | "blocked";
    workflowId: number;
    workflowPath?: string;
    ref: string;
    sha?: string;
    defaultBranch?: string;
    inputs?: readonly DispatchInputDefinition[];
    environments?: readonly WorkflowEnvironmentRef[];
    reason?: string;
  };
  validation: {
    valid: boolean;
    values: Record<string, string>;
    errors: Record<string, string>;
  };
  reviewToken?: string;
  /** Whether the GitHub token can read team membership, which team-reviewed environments may need. */
  orgReadAccess?: boolean;
  environmentInventory?: {
    state: "loaded" | "partial" | "permission_restricted" | "unavailable";
    names?: string[];
    reason?: string;
    manualEntryAllowed?: boolean;
  };
}

// GitHub usually creates a dispatched run 1-3s after accepting the request, so poll quickly at first.
const ASSOCIATION_RETRY_DELAYS_MS = [1_500, 2_000, 3_000, 5_000, 8_000, 13_000, 15_000] as const;
// Matches the host's association window (seconds after acceptance a run may still be matched).
const ASSOCIATION_WINDOW_MS = 120_000;

type DispatchResult = (
  | {
      state: "request_accepted";
      association: "not_observed" | "unavailable";
      submittedAt: number;
      acceptedAt: number;
    }
  | { state: "associated_run_found"; runId: number; runStatus: string; htmlUrl: string }
  | { state: "completed"; runId: number; conclusion: string | null; htmlUrl: string }
  | { state: "outcome_uncertain"; reconciliation: string }
) & { autoApproval?: AutoApprovalScope };

export function Companion({
  bridge,
  workflowId,
  workflowPath,
  workflowName,
  latestRunStatus,
  onInspectRun,
  onDispatched,
  previewRefreshKey = 0,
  initialRef,
  initialInputs,
  previousRuns = [],
}: {
  bridge: Bridge;
  workflowId?: number;
  workflowPath: string;
  workflowName: string;
  latestRunId?: number;
  latestRunStatus?: string;
  onInspectLatest?(): void;
  onInspectRun?(runId: number): void;
  /** Fires when GitHub accepted a dispatch or its run was found, so run lists can refresh. */
  onDispatched?(): void;
  previewRefreshKey?: number;
  /** Prefill a previous run without dispatching it. Values are still schema-validated by the host. */
  initialRef?: string;
  initialInputs?: ReadonlyArray<{ name: string; value: string }>;
  previousRuns?: readonly WorkflowRunRecord[];
  onClose(): void;
}) {
  const [preview, setPreview] = useState<LocalPreview>();
  const [remote, setRemote] = useState<DispatchValidation>();
  const [ref, setRef] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DispatchResult>();
  const [submitting, setSubmitting] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [autoAssociating, setAutoAssociating] = useState(false);
  const [associationTimedOut, setAssociationTimedOut] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reuseNotice, setReuseNotice] = useState<{
    runId: number;
    recorded: boolean;
    sensitiveNames: string[];
  }>();
  const [error, setError] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const branches = useRemoteBranches(bridge, workflowId !== undefined);

  async function loadLocalPreview() {
    try {
      const local = await bridge.request<LocalPreview>("workflow.localPreview", { workflowPath });
      setPreview(local);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function loadRemoteDefinition(targetRef = ref, inputValues = values, review = false) {
    if (workflowId === undefined) return undefined;
    setLoading(true);
    setError("");
    setResult(undefined);
    try {
      const response = await bridge.request<DispatchValidation>("dispatch.validate", {
        workflowId,
        ...(targetRef ? { ref: targetRef } : {}),
        inputs: inputValues,
        ...(review ? { review: true } : {}),
      });
      setRemote(response);
      setRef(response.target.ref);
      if (response.target.state === "available" && !review) {
        const allowed = new Set(response.target.inputs?.map((input) => input.name) ?? []);
        setValues(Object.fromEntries(
          Object.entries(response.validation.values).filter(([name]) => allowed.has(name)),
        ));
      }
      return response;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLocalPreview();
  }, [bridge, workflowPath, previewRefreshKey]);

  useEffect(() => {
    setAutoApprove(false);
  }, [bridge, workflowId, workflowPath]);

  // Wait for branch inventory, then validate either the supplied previous-run handoff or normal defaults.
  useEffect(() => {
    if (workflowId === undefined || !branches.settled) return;
    const previousInputs = Object.fromEntries(
      (initialInputs ?? [])
        .filter((input) => !isSensitiveInputName(input.name))
        .map((input) => [input.name, input.value]),
    );
    void loadRemoteDefinition(initialRef ?? branches.current ?? "", previousInputs, false);
  }, [bridge, workflowId, workflowPath, branches.settled, initialRef, initialInputs]);

  const inputs = remote?.target.state === "available" ? remote.target.inputs ?? [] : [];
  const omittedSensitiveInputs = (initialInputs ?? []).filter((input) => isSensitiveInputName(input.name));

  const changedInputNames = useMemo(() => {
    if (!preview || !remote || remote.target.state !== "available") return new Set<string>();
    const remoteByName = new Map((remote.target.inputs ?? []).map((i) => [i.name, inputFingerprint(i)]));
    const changed = new Set<string>();
    for (const localInput of preview.inputs ?? []) {
      const remoteFp = remoteByName.get(localInput.name);
      if (!remoteFp || JSON.stringify(remoteFp) !== JSON.stringify(inputFingerprint(localInput))) {
        changed.add(localInput.name);
      }
    }
    return changed;
  }, [preview, remote]);

  const localDifferences = useMemo(() => {
    if (!preview || !remote || remote.target.state !== "available") return false;
    return !preview.dispatchable || changedInputNames.size > 0;
  }, [preview, remote, changedInputNames]);

  async function startFromPreviousRun(runId: number) {
    if (!runId) {
      setReuseNotice(undefined);
      return;
    }
    setLoading(true);
    setError("");
    setResult(undefined);
    try {
      const previous = await bridge.request<{
        ref?: string;
        dispatchInputs?: ReadonlyArray<{ name: string; value: string }>;
      }>("run.inspect", { runId });
      const allInputs = previous.dispatchInputs ?? [];
      const reusable = allInputs.filter((input) => !isSensitiveInputName(input.name));
      setReuseNotice({
        runId,
        recorded: previous.dispatchInputs !== undefined,
        sensitiveNames: allInputs.filter((input) => isSensitiveInputName(input.name)).map((input) => input.name),
      });
      await loadRemoteDefinition(
        previous.ref ?? ref,
        Object.fromEntries(reusable.map((input) => [input.name, input.value])),
        false,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  function resetDefaults() {
    setValues(Object.fromEntries(inputs.map((input) => [input.name, input.defaultValue ?? ""])));
    setResult(undefined);
    setError("");
    setRemote((current) => current && ({
      ...current,
      validation: { ...current.validation, errors: {} },
    }));
  }

  function updateInput(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setResult(undefined);
    // Host errors describe the previous value; Trigger revalidates anyway.
    setRemote((current) => {
      if (!current?.validation.errors[name]) return current;
      const { [name]: _cleared, ...errors } = current.validation.errors;
      return { ...current, validation: { ...current.validation, errors } };
    });
  }

  async function triggerWorkflow() {
    if (workflowId === undefined) return;
    setSubmitting(true);
    setError("");
    setResult(undefined);
    try {
      const validated = await bridge.request<DispatchValidation>("dispatch.validate", {
        workflowId,
        ...(ref ? { ref } : {}),
        inputs: values,
        review: true,
      });
      setRemote(validated);
      if (validated.target.state !== "available") {
        setError(`Not dispatched: ${validated.target.reason ?? "the workflow is unavailable on this ref."}`);
        return;
      }
      if (!validated.validation.valid) {
        const details = Object.entries(validated.validation.errors)
          .map(([name, message]) => (name === "_form" ? message : `${name}: ${message}`))
          .join(" ");
        setError(`Not dispatched: ${details || "inputs failed validation."}`);
        return;
      }
      if (!validated.reviewToken) {
        setError("Not dispatched: the extension did not issue a review token. Try again.");
        return;
      }
      const submission = await bridge.request<DispatchResult>("dispatch.submit", {
        workflowId,
        ref: validated.target.ref,
        inputs: validated.validation.values,
        reviewToken: validated.reviewToken,
        ...(autoApprove && (validated.target.environments?.length ?? 0) > 0 ? { autoApproveEnvironments: true } : {}),
      });
      setResult(submission);
      setAutoApprove(false);
      if (submission.state !== "outcome_uncertain") onDispatched?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function checkAssociation() {
    if (workflowId === undefined || result?.state !== "request_accepted") return;
    setAssociating(true);
    setError("");
    try {
      const association = await bridge.request<DispatchResult>("dispatch.association", {
        workflowId,
        ref: remote?.target.ref ?? ref,
        submittedAt: result.submittedAt,
        acceptedAt: result.acceptedAt,
      });
      setResult({ ...association, ...(result.autoApproval ? { autoApproval: result.autoApproval } : {}) });
      if (association.state === "associated_run_found" || association.state === "completed") onDispatched?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAssociating(false);
    }
  }

  // Keep looking for the dispatched run on a short backoff instead of waiting for a manual "Find run".
  useEffect(() => {
    if (workflowId === undefined || result?.state !== "request_accepted" || result.association !== "not_observed") {
      return;
    }
    const accepted = result;
    const targetRef = remote?.target.ref ?? ref;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const scheduleNext = () => {
      if (cancelled) return;
      if (Date.now() - accepted.acceptedAt >= ASSOCIATION_WINDOW_MS) {
        setAutoAssociating(false);
        setAssociationTimedOut(true);
        return;
      }
      const delay = ASSOCIATION_RETRY_DELAYS_MS[Math.min(attempt, ASSOCIATION_RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      try {
        const association = await bridge.request<DispatchResult>("dispatch.association", {
          workflowId,
          ref: targetRef,
          submittedAt: accepted.submittedAt,
          acceptedAt: accepted.acceptedAt,
        });
        if (cancelled) return;
        if (association.state === "request_accepted" && association.association === "not_observed") {
          scheduleNext();
          return;
        }
        setResult({ ...association, ...(accepted.autoApproval ? { autoApproval: accepted.autoApproval } : {}) });
        if (association.state === "associated_run_found" || association.state === "completed") onDispatched?.();
      } catch {
        scheduleNext();
      }
    };

    setAssociationTimedOut(false);
    setAutoAssociating(true);
    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      setAutoAssociating(false);
    };
  }, [result, workflowId, bridge]);

  const trackerStage: DispatchTrackerStage | null = useMemo(() => {
    if (submitting) return "submitting";
    if (associating || autoAssociating) return "associating";
    if (!result) return null;
    if (result.state === "request_accepted") return "accepted";
    if (result.state === "associated_run_found" || result.state === "completed") return "found";
    return "uncertain";
  }, [submitting, associating, autoAssociating, result]);

  const targetRefLabel = remote?.target.ref || ref || "main";
  const targetShaLabel = remote?.target.sha ? ` @ ${remote.target.sha.slice(0, 7)}` : "";
  const isLocalOnly = workflowId === undefined;

  return (
    <form
      className="companion"
      aria-label="Workflow Companion"
      onSubmit={(event) => {
        event.preventDefault();
        void triggerWorkflow();
      }}
    >
      {previousRuns.length > 0 ? (
        <div className="companion__reuse">
          <Icon name="history" size={14} tone="muted" />
          <label className="companion__reuse-label" htmlFor="companion-previous-run">
            Start from a previous run
          </label>
          <span className="ad-select companion__reuse-select">
            <select
              id="companion-previous-run"
              value={reuseNotice?.runId ?? ""}
              disabled={loading}
              onChange={(event) => void startFromPreviousRun(Number(event.target.value))}
            >
              <option value="">Choose a run…</option>
              {previousRuns.map((run) => (
                <option key={run.id} value={run.id}>{`#${run.id} · ${run.displayTitle} · ${run.branch}`}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={12} />
          </span>
        </div>
      ) : null}

      {reuseNotice ? (
        <Banner tone="info" title={`Starting from run #${reuseNotice.runId}`}>
          {!reuseNotice.recorded
            ? "Recorded inputs are unavailable. GitHub does not return historical dispatch values; enter any required inputs below."
            : reuseNotice.sensitiveNames.length > 0
              ? `Reusable values are prefilled. Sensitive inputs were omitted (${reuseNotice.sensitiveNames.join(", ")}) and must be re-entered if required.`
              : "Recorded non-sensitive values are prefilled for review. Nothing runs until you select Run workflow."}
        </Banner>
      ) : initialRef !== undefined ? (
        <Banner tone="info" title="Starting from a previous run">
          {initialInputs === undefined
            ? "Recorded inputs are unavailable. GitHub does not return historical dispatch values, so ActionDeck can only prefill inputs it recorded; re-enter them below."
            : omittedSensitiveInputs.length > 0
              ? `Sensitive inputs were omitted (${omittedSensitiveInputs.map((input) => input.name).join(", ")}) and must be re-entered if required.`
              : "The ref and recorded inputs are prefilled for review. Nothing runs until you select Run workflow."}
        </Banner>
      ) : null}

      {localDifferences ? (
        <Banner
          tone="warning"
          title={`Unpushed local YAML differs from remote ${targetRefLabel}${targetShaLabel}`}
        >
          Dispatch runs the remote version. Commit and push to run your local changes.
        </Banner>
      ) : isLocalOnly ? (
        <Banner tone="warning" title="Local-only workflow">
          {preview?.warning ??
            "This local YAML is preview-only and will not be executed or uploaded."}
        </Banner>
      ) : null}

      <div className="ad-field companion__ref">
        <label className="ad-field__label" htmlFor="companion-ref-input">
          <span>Branch or ref</span>
        </label>
        <div className="companion__ref-row">
          <BranchRefInput
            id="companion-ref-input"
            ariaLabel="Remote branch or ref"
            value={ref}
            branches={branches}
            disabled={isLocalOnly}
            onChange={(next) => {
              setRef(next);
              setResult(undefined);
            }}
            onCommit={(next) => {
              if (next && next !== remote?.target.ref) void loadRemoteDefinition(next, {}, false);
            }}
          />
          <Button
            variant="ghost"
            icon="cloud-download"
            title="Load remote inputs"
            busy={loading}
            disabled={isLocalOnly}
            onClick={() => void loadRemoteDefinition(ref, {}, false)}
          />
          <Button
            variant="ghost"
            icon="discard"
            title="Reset defaults"
            disabled={inputs.length === 0 || submitting}
            onClick={resetDefaults}
          />
        </div>
      </div>

      {isLocalOnly ? (
        <StateNotice
          kind="empty"
          title="Push this workflow to run it"
          detail="This local workflow is not present in the remote repository and cannot be dispatched."
          inline
        />
      ) : null}

      {remote?.target.state === "blocked" ? (
        <StateNotice kind="restricted" title="Dispatch unavailable" detail={remote.target.reason} inline />
      ) : null}

      {remote?.environmentInventory?.state === "permission_restricted" ? (
        <p className="ad-caption ad-muted" role="status">
          Environment listing is restricted. Enter and validate the environment name manually.
        </p>
      ) : null}

      {inputs.map((input) => (
        <DispatchField
          key={input.name}
          type={input.type}
          name={input.name}
          label={input.name}
          required={Boolean(input.required)}
          value={values[input.name] ?? input.defaultValue ?? ""}
          options={
            input.type === "environment"
              ? remote?.environmentInventory?.names ?? []
              : input.options ?? []
          }
          description={input.description}
          defaultValue={input.defaultValue}
          error={remote?.validation.errors[input.name]}
          changed={changedInputNames.has(input.name)}
          sensitive={isSensitiveInputName(input.name)}
          onChange={(value) => updateInput(input.name, value)}
        />
      ))}

      {remote?.target.state === "available" ? (
        <AutoApproveConsent
          environments={remote.target.environments}
          inputs={{
            ...Object.fromEntries(inputs.map((input) => [input.name, input.defaultValue ?? ""])),
            ...values,
          }}
          checked={autoApprove}
          disabled={submitting}
          orgReadAccess={remote.orgReadAccess}
          onGrantOrgAccess={() => {
            void bridge
              .request<{ granted: boolean; orgReadAccess: boolean }>("auth.grantOrgAccess", {})
              .then((response) => {
                setRemote((current) => current && { ...current, orgReadAccess: response.orgReadAccess });
              })
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
          }}
          onChange={setAutoApprove}
        />
      ) : null}

      {remote?.validation.errors._form ? (
        <p className="ad-field__error" role="alert">
          <Icon name="error" size={14} tone="failure" />
          <span>{remote.validation.errors._form}</span>
        </p>
      ) : null}

      {trackerStage ? (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <DispatchTracker
            stage={trackerStage}
            detail={result ? dispatchResultMessage(result, associationTimedOut) : undefined}
            actions={
              result?.state === "request_accepted" || result?.state === "outcome_uncertain" ? (
                <Button
                  variant="secondary"
                  busy={associating}
                  onClick={() => void checkAssociation()}
                >
                  Find run
                </Button>
              ) : result?.state === "associated_run_found" || result?.state === "completed" ? (
                <>
                  {onInspectRun ? (
                    <Button variant="secondary" icon="eye" onClick={() => onInspectRun(result.runId)}>
                      Open run #{result.runId}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    icon="link-external"
                    onClick={() => {
                      void bridge.request("external.open", { url: result.htmlUrl }).catch((reason: unknown) => {
                        setError(reason instanceof Error ? reason.message : String(reason));
                      });
                    }}
                  >
                    View on GitHub
                  </Button>
                </>
              ) : undefined
            }
          />
        </div>
      ) : null}

      {error ? <StateNotice kind="stale" title="Dispatch error" detail={error} inline /> : null}

      {localDifferences ? (
        <CopilotAction
          label="Propose YAML fix"
          onClick={() => {
            setError("");
            void bridge.request("workflow.proposeFix", { workflowPath }).catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        />
      ) : null}

      <div className="ad-drawer__foot companion__footer">
        <div className="ad-caption ad-muted companion__target" title={`${workflowPath} on ${targetRefLabel}${targetShaLabel}`}>
          <Icon name="git-branch" size={14} />
          <span className="companion__target-wide">Runs the remote</span>
          <span className="ad-mono-sm companion__target-path companion__target-wide">{workflowPath.split("/").pop()}</span>
          <span aria-hidden="true">on</span>
          <span className="ad-mono-sm companion__target-ref">{targetRefLabel}{targetShaLabel}</span>
          {latestRunStatus ? <StatusLabel status={normalizeStatus(latestRunStatus)} iconOnly /> : null}
        </div>
        <span className="ad-toolbar__spacer" />
        <Button
          variant="primary"
          icon="play"
          type="submit"
          busy={submitting}
          disabled={isLocalOnly || loading || remote?.target.state === "blocked"}
          title={isLocalOnly ? "Push this workflow to run it" : `Run ${workflowName} on ${targetRefLabel}`}
        >
          Run workflow
        </Button>
      </div>
    </form>
  );
}

function inputFingerprint(input: DispatchInputDefinition): unknown[] {
  return [
    input.name,
    input.type,
    input.description ?? "",
    input.required,
    input.defaultValue ?? "",
    input.options ?? [],
  ];
}

function dispatchResultMessage(result: DispatchResult, associationTimedOut = false): string {
  const armed = result.autoApproval
    ? ` Auto-approval armed for ${result.autoApproval.environments === null ? "every gate of this run" : result.autoApproval.environments.join(", ")}.`
    : "";
  const message = associationTimedOut && result.state === "request_accepted" && result.association === "not_observed"
    ? "GitHub accepted the dispatch, but no matching run appeared within 2 minutes. Use Find run to check again."
    : dispatchStateMessage(result);
  return message + armed;
}

function dispatchStateMessage(result: DispatchResult): string {
  switch (result.state) {
    case "request_accepted":
      return result.association === "unavailable"
        ? "GitHub accepted the dispatch; run association is temporarily unavailable."
        : "GitHub accepted the dispatch; waiting for a matching run to appear.";
    case "associated_run_found":
      return `Run #${result.runId} observed (${result.runStatus}).`;
    case "completed":
      return `Run #${result.runId} completed: ${result.conclusion ?? "unknown"}.`;
    case "outcome_uncertain":
      return `Dispatch outcome is uncertain (${result.reconciliation}). Refresh before trying again.`;
  }
}
