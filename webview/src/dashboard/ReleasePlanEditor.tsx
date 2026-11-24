import { useEffect, useId, useRef, useState } from "react";
import type { DispatchInputDefinition, WorkflowEnvironmentRef } from "../../../src/domain/models/dispatch";
import { MAX_WAIT_BEFORE_MINUTES, type PlanGate, type ReleasePlan } from "../../../src/domain/models/release-plan";
import { resolveAutoApprovalScope } from "../../../src/domain/services/auto-approval-scope";
import { isSensitiveInputName } from "../../../src/domain/services/plan-transitions";
import type { Bridge } from "../bridge";
import { AutoApproveConsent } from "../components/AutoApproveConsent";
import { Banner } from "../components/Banner";
import { BranchRefInput, useRemoteBranches } from "../components/BranchRefInput";
import { Button } from "../components/Button";
import { DispatchField } from "../components/DispatchField";
import { Icon } from "../components/Icon";

export interface PlanWorkflowOption {
  readonly workflowId: number;
  readonly name: string;
  readonly path: string;
  readonly defaultBranch?: string;
}

interface InputRow {
  rowId: number;
  key: string;
  value: string;
}

/** The workflow_dispatch definition read from the remote workflow at the step's ref, as Run now does. */
type StepDefinition =
  | { readonly status: "loading"; readonly ref: string }
  | {
    readonly status: "loaded";
    readonly ref: string;
    readonly inputs: readonly DispatchInputDefinition[];
    readonly environments?: readonly WorkflowEnvironmentRef[];
    readonly environmentNames: readonly string[];
  }
  | { readonly status: "unavailable"; readonly ref: string; readonly reason: string };

interface DefinitionResponse {
  target?: {
    state?: string;
    ref?: string;
    inputs?: readonly DispatchInputDefinition[];
    environments?: readonly WorkflowEnvironmentRef[];
    reason?: string;
  };
  validation?: { values?: Record<string, string> };
  environmentInventory?: { names?: string[] };
}

interface EditableStep {
  id: string;
  workflowId: number;
  workflowPath: string;
  ref: string;
  gate: PlanGate;
  /** Free-form rows, used only when the workflow definition could not be read. */
  inputs: InputRow[];
  /** Values for the inputs the workflow declares. */
  values: Record<string, string>;
  definition: StepDefinition;
  autoApprove: boolean;
  sensitiveKeysText: string;
  /** Starts together with the step above. */
  parallelWithPrevious: boolean;
  /** Minutes to wait before this step starts, as typed. */
  waitText: string;
  confirmBefore: boolean;
}

function definedValues(step: EditableStep): Record<string, string> {
  if (step.definition.status !== "loaded") return {};
  return Object.fromEntries(step.definition.inputs.map((input) => [
    input.name,
    step.values[input.name] ?? input.defaultValue ?? "",
  ]));
}

type ScheduleMode = "none" | "relative" | "absolute";

const MAX_STEPS = 20;
const MAX_INPUTS_PER_STEP = 25;

interface ResolvedSchedule {
  readonly kind: "relative" | "absolute";
  readonly runAtMs: number;
  readonly delayMs?: number;
}

function resolveSchedule(mode: ScheduleMode, delayMinutes: string, absoluteLocal: string, now: number): ResolvedSchedule | undefined {
  if (mode === "relative") {
    const minutes = Number(delayMinutes);
    if (delayMinutes.trim() === "" || !Number.isFinite(minutes) || minutes <= 0) return undefined;
    return { kind: "relative", delayMs: minutes * 60_000, runAtMs: now + minutes * 60_000 };
  }
  if (mode === "absolute") {
    // datetime-local values carry no zone, so they are interpreted in the local time zone.
    const runAtMs = absoluteLocal ? new Date(absoluteLocal).getTime() : Number.NaN;
    return Number.isFinite(runAtMs) ? { kind: "absolute", runAtMs } : undefined;
  }
  return undefined;
}

/** `YYYY-MM-DDTHH:mm` in local time, the value a datetime-local input expects. */
function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatLocalTimestamp(runAtMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long", timeZone }).format(new Date(runAtMs));
}

export function ReleasePlanEditor({
  bridge,
  workflows,
  heading = "Release Plan Editor",
  initialName = "Release Plan",
  defaultScheduleMode = "none",
  plan: existingPlan,
  onSaved,
  onClose,
}: {
  bridge: Bridge;
  workflows: readonly PlanWorkflowOption[];
  heading?: string;
  initialName?: string;
  defaultScheduleMode?: ScheduleMode;
  /** A saved plan that has not started yet; the editor opens with its steps and saves over it. */
  plan?: ReleasePlan;
  onSaved(plan: ReleasePlan): void;
  onClose(): void;
}) {
  const nextRowId = useRef(1);
  const [name, setName] = useState(existingPlan?.name ?? initialName);
  const [steps, setSteps] = useState<EditableStep[]>(() => existingPlan
    ? existingPlan.steps.map((step) => ({
      id: step.id,
      workflowId: step.workflowId,
      workflowPath: step.workflowPath,
      ref: step.ref,
      // Plans from earlier builds may carry the retired gate, which always behaved like on_success.
      gate: step.gate === "stop_on_non_success" ? "on_success" : step.gate,
      parallelWithPrevious: Boolean(step.parallelWithPrevious),
      waitText: step.waitBeforeMinutes ? String(step.waitBeforeMinutes) : "",
      confirmBefore: Boolean(step.confirmBefore),
      // Used only if the workflow definition cannot be read; otherwise the saved values seed the form.
      inputs: Object.entries(step.inputs).map(([key, value]) => ({ rowId: nextRowId.current++, key, value })),
      values: { ...step.inputs },
      definition: { status: "loading", ref: step.ref },
      autoApprove: Boolean(step.autoApprove),
      sensitiveKeysText: step.sensitiveInputKeys.join(", "),
    }))
    : workflows.map((w, idx) => ({
      id: `step-${idx + 1}`,
      workflowId: w.workflowId,
      workflowPath: w.path,
      ref: w.defaultBranch ?? "main",
      gate: "on_success",
      parallelWithPrevious: false,
      waitText: "",
      confirmBefore: false,
      inputs: [],
      values: {},
      definition: { status: "loading", ref: w.defaultBranch ?? "main" },
      autoApprove: false,
      sensitiveKeysText: "",
    })),
  );
  const uid = useId();
  const branches = useRemoteBranches(bridge);
  // A saved schedule reopens as its absolute start time, so editing never silently shifts it.
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    existingPlan ? (existingPlan.schedule ? "absolute" : "none") : defaultScheduleMode,
  );
  const [delayMinutes, setDelayMinutes] = useState("");
  const [absoluteLocal, setAbsoluteLocal] = useState(
    existingPlan?.schedule ? toLocalInputValue(existingPlan.schedule.runAtMs) : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const resolvedPreview = resolveSchedule(scheduleMode, delayMinutes, absoluteLocal, Date.now());

  function updateStep(index: number, patch: Partial<EditableStep>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function patchStepById(stepId: string, patch: (step: EditableStep) => Partial<EditableStep>) {
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, ...patch(s) } : s)));
  }

  async function loadDefinition(stepId: string, workflowId: number, ref: string) {
    patchStepById(stepId, () => ({ definition: { status: "loading", ref } }));
    let definition: StepDefinition;
    let values: Record<string, string> = {};
    try {
      const response = await bridge.request<DefinitionResponse>("dispatch.validate", {
        workflowId,
        ...(ref ? { ref } : {}),
        inputs: {},
      });
      const target = response?.target;
      if (target?.state === "available" && Array.isArray(target.inputs)) {
        definition = {
          status: "loaded",
          ref,
          inputs: target.inputs,
          ...(target.environments ? { environments: target.environments } : {}),
          environmentNames: response.environmentInventory?.names ?? [],
        };
        values = { ...(response.validation?.values ?? {}) };
      } else {
        definition = {
          status: "unavailable",
          ref,
          reason: target?.reason ?? "The workflow inputs could not be read.",
        };
      }
    } catch (reason) {
      definition = {
        status: "unavailable",
        ref,
        reason: reason instanceof Error ? reason.message : String(reason),
      };
    }
    // A newer load for another ref wins; drop results that arrive late.
    // Values already in the form (typed, or saved in an edited plan) win over the workflow's defaults.
    patchStepById(stepId, (current) => (current.definition.ref !== ref
      ? {}
      : {
        definition,
        values: { ...values, ...current.values },
        ...(definition.status === "loaded" ? {} : { autoApprove: false }),
      }));
  }

  useEffect(() => {
    for (const step of steps) void loadDefinition(step.id, step.workflowId, step.ref);
    // Definitions load once on open; ref edits reload a single step on blur.
  }, [bridge]);

  function updateRow(index: number, rowId: number, patch: Partial<InputRow>) {
    setSteps((prev) => prev.map((s, i) => (i === index
      ? { ...s, inputs: s.inputs.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)) }
      : s)));
  }

  function addRow(index: number) {
    const rowId = nextRowId.current++;
    setSteps((prev) => prev.map((s, i) => (i === index
      ? { ...s, inputs: [...s.inputs, { rowId, key: "", value: "" }] }
      : s)));
  }

  function removeRow(index: number, rowId: number) {
    setSteps((prev) => prev.map((s, i) => (i === index
      ? { ...s, inputs: s.inputs.filter((row) => row.rowId !== rowId) }
      : s)));
  }

  function moveStep(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    setSteps((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return next;
    });
  }

  async function savePlan() {
    setBusy(true);
    setError("");
    try {
      if (steps.length > MAX_STEPS) {
        throw new Error(`A release plan supports at most ${MAX_STEPS} steps; deselect some workflows.`);
      }
      if (steps.some((step) => step.definition.status === "loading")) {
        throw new Error("Workflow inputs are still loading.");
      }
      const parsedSteps = steps.map((step, index) => {
        const inputs: Record<string, string> = {};
        if (step.definition.status === "loaded") {
          if (step.definition.ref !== step.ref) {
            throw new Error(`Reload inputs for ${step.workflowPath} after changing its ref.`);
          }
          const current = definedValues(step);
          for (const input of step.definition.inputs) {
            const value = current[input.name] ?? "";
            if (input.required && value.trim() === "") {
              throw new Error(`Input '${input.name}' is required for ${step.workflowPath}.`);
            }
            if (value !== "") inputs[input.name] = value;
          }
        } else {
          for (const row of step.inputs) {
            const key = row.key.trim();
            if (!key) continue;
            if (key in inputs) throw new Error(`Duplicate input '${key}' for ${step.workflowPath}.`);
            inputs[key] = row.value;
          }
        }
        if (Object.keys(inputs).length > MAX_INPUTS_PER_STEP) {
          throw new Error(`${step.workflowPath} supports at most ${MAX_INPUTS_PER_STEP} inputs.`);
        }
        const startsStage = index > 0 && !step.parallelWithPrevious;
        let waitBeforeMinutes = 0;
        if (startsStage && step.waitText.trim() !== "") {
          waitBeforeMinutes = Number(step.waitText);
          if (!Number.isInteger(waitBeforeMinutes) || waitBeforeMinutes < 0 || waitBeforeMinutes > MAX_WAIT_BEFORE_MINUTES) {
            throw new Error(`The wait before ${step.workflowPath} must be a whole number of minutes from 0 to ${MAX_WAIT_BEFORE_MINUTES}.`);
          }
        }
        const sensitiveInputKeys = step.sensitiveKeysText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          id: step.id,
          workflowId: step.workflowId,
          workflowPath: step.workflowPath,
          ref: step.ref,
          inputs,
          sensitiveInputKeys,
          gate: step.gate,
          ...(index > 0 && step.parallelWithPrevious ? { parallelWithPrevious: true } : {}),
          ...(waitBeforeMinutes > 0 ? { waitBeforeMinutes } : {}),
          ...(startsStage && step.confirmBefore ? { confirmBefore: true } : {}),
          ...(step.autoApprove && step.definition.status === "loaded" && step.definition.environments?.length
            ? { autoApprove: { environments: resolveAutoApprovalScope(step.definition.environments, inputs).environments } }
            : {}),
        };
      });

      let schedule: (ResolvedSchedule & { timeZone: string }) | undefined;
      if (scheduleMode !== "none") {
        const resolved = resolveSchedule(scheduleMode, delayMinutes, absoluteLocal, Date.now());
        if (!resolved) {
          throw new Error(scheduleMode === "relative"
            ? "Enter a delay greater than 0 minutes."
            : "Choose a valid local date and time.");
        }
        if (resolved.runAtMs <= Date.now()) throw new Error("The scheduled start must be in the future.");
        schedule = { ...resolved, timeZone };
      }

      const plan = await bridge.request<ReleasePlan>("plan.save", {
        id: existingPlan?.id ?? `plan-${Date.now()}`,
        name: name.trim() || initialName,
        steps: parsedSteps,
        ...(schedule ? { schedule } : {}),
      });
      onSaved(plan);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const sensitiveKeysFor = (step: EditableStep) => step.sensitiveKeysText.split(",").map((k) => k.trim()).filter(Boolean);

  return (
    <section aria-label="Release Plan Editor" className="ad-planedit">
      <header className="ad-planedit__head">
        <h3 className="ad-planedit__title">{heading}</h3>
        <Button variant="ghost" icon="close" title="Close" aria-label="Close" onClick={onClose} />
      </header>

      {error && (
        <Banner tone="error" title={error} />
      )}

      <div className="ad-planedit__grid">
        <div className="ad-field">
          <label className="ad-field__label" htmlFor={`${uid}-name`}><span>Plan name</span></label>
          <input id={`${uid}-name`} className="ad-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="ad-field">
          <label className="ad-field__label" htmlFor={`${uid}-mode`}><span>Start</span></label>
          <span className="ad-select">
            <select
              id={`${uid}-mode`}
              aria-label="Schedule mode"
              value={scheduleMode}
              onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
            >
              <option value="none">Start manually</option>
              <option value="relative">After a delay</option>
              <option value="absolute">At a specific local date and time</option>
            </select>
            <Icon name="chevron-down" size={14} />
          </span>
        </div>
        {scheduleMode === "relative" && (
          <div className="ad-field">
            <label className="ad-field__label" htmlFor={`${uid}-delay`}><span>Delay (minutes)</span></label>
            <input
              id={`${uid}-delay`}
              className="ad-input"
              aria-label="Delay in minutes"
              type="number"
              min={0}
              placeholder="e.g. 15"
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(e.target.value)}
            />
          </div>
        )}
        {scheduleMode === "absolute" && (
          <div className="ad-field">
            <label className="ad-field__label" htmlFor={`${uid}-at`}><span>Local date and time</span></label>
            <input
              id={`${uid}-at`}
              className="ad-input"
              aria-label="Local date and time"
              type="datetime-local"
              value={absoluteLocal}
              onChange={(e) => setAbsoluteLocal(e.target.value)}
            />
          </div>
        )}
      </div>

      {scheduleMode !== "none" && (
        <div aria-label="Resolved schedule">
          <Banner
            tone="info"
            icon="calendar"
            title={resolvedPreview
              ? `Starts ${formatLocalTimestamp(resolvedPreview.runAtMs, timeZone)} (${timeZone})`
              : "Enter a valid value to preview the local start time"}
          >
            Scheduling runs in the local VS Code Extension Host, not on a remote server. Keep this window open;
            if the machine sleeps or VS Code closes, the plan waits for you instead of starting late.
          </Banner>
        </div>
      )}

      {steps.length > MAX_STEPS && (
        <div role="alert">
          <Banner tone="warning" title={`A release plan supports at most ${MAX_STEPS} steps`}>
            Deselect some workflows before saving.
          </Banner>
        </div>
      )}

      <h4 className="ad-section ad-planedit__section">{steps.length === 1 ? "Workflow" : `Steps (${steps.length})`}</h4>
      <ol className="ad-planedit__steps">
        {steps.map((step, index) => (
          <li key={step.id} className="ad-planedit__step">
            <div className="ad-planedit__stephead">
              {steps.length > 1 && <span className="ad-plan__num">{index + 1}</span>}
              <strong className="ad-mono ad-planedit__path" title={step.workflowPath}>{step.workflowPath}</strong>
              {steps.length > 1 && (
                <span className="ad-planedit__order">
                  <Button variant="ghost" icon="arrow-up" title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => moveStep(index, -1)} />
                  <Button variant="ghost" icon="arrow-down" title="Move down" aria-label="Move down" disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)} />
                </span>
              )}
            </div>

            <div className="ad-planedit__grid">
              <div className="ad-field">
                <label className="ad-field__label" htmlFor={`${uid}-${step.id}-ref`}><span>Ref</span></label>
                <BranchRefInput
                  id={`${uid}-${step.id}-ref`}
                  ariaLabel={`Ref for ${step.workflowPath}`}
                  value={step.ref}
                  branches={branches}
                  onChange={(ref) => updateStep(index, { ref })}
                  onCommit={(ref) => {
                    if (ref && ref !== step.definition.ref) void loadDefinition(step.id, step.workflowId, ref);
                  }}
                />
              </div>
              {index > 0 && (
              <div className="ad-field">
                <label className="ad-field__label" htmlFor={`${uid}-${step.id}-start`}><span>Starts</span></label>
                <span className="ad-select">
                  <select
                    id={`${uid}-${step.id}-start`}
                    aria-label={`Start of ${step.workflowPath}`}
                    value={step.parallelWithPrevious ? "together" : "after"}
                    onChange={(e) => updateStep(index, { parallelWithPrevious: e.target.value === "together" })}
                  >
                    <option value="after">After the step above</option>
                    <option value="together">Together with the step above</option>
                  </select>
                  <Icon name="chevron-down" size={14} />
                </span>
                <span className="ad-field__help">
                  {step.parallelWithPrevious
                    ? "Both are dispatched at once; the plan moves on when all steps that start together have finished."
                    : "Starts once the steps above have finished and their rules allow it."}
                </span>
              </div>
              )}
              {steps.length > 1 && (
              <div className="ad-field">
                <label className="ad-field__label" htmlFor={`${uid}-${step.id}-gate`}><span>When this step finishes</span></label>
                <span className="ad-select">
                  <select
                    id={`${uid}-${step.id}-gate`}
                    aria-label={`Gate for ${step.workflowPath}`}
                    value={step.gate}
                    onChange={(e) => updateStep(index, { gate: e.target.value as PlanGate })}
                  >
                    <option value="on_success">Continue only if it succeeds</option>
                    <option value="on_any_completion">Continue whatever the result</option>
                  </select>
                  <Icon name="chevron-down" size={14} />
                </span>
                <span className="ad-field__help">Decides whether the steps after this one start.</span>
              </div>
              )}
            </div>

            {index > 0 && !step.parallelWithPrevious && (
            <div className="ad-planedit__grid">
              <div className="ad-field">
                <label className="ad-field__label" htmlFor={`${uid}-${step.id}-wait`}><span>Wait before starting (minutes)</span></label>
                <input
                  id={`${uid}-${step.id}-wait`}
                  className="ad-input"
                  aria-label={`Wait before ${step.workflowPath} in minutes`}
                  type="number"
                  min={0}
                  max={MAX_WAIT_BEFORE_MINUTES}
                  placeholder="0"
                  value={step.waitText}
                  onChange={(e) => updateStep(index, { waitText: e.target.value })}
                />
                <span className="ad-field__help">Counted from when the steps above finish. Keep VS Code open while it waits.</span>
              </div>
              <label className="ad-check ad-planedit__check">
                <input
                  type="checkbox"
                  aria-label={`Ask before starting ${step.workflowPath}`}
                  checked={step.confirmBefore}
                  onChange={(e) => updateStep(index, { confirmBefore: e.target.checked })}
                />
                <span>Ask me before starting this step</span>
              </label>
            </div>
            )}

            <div className="ad-field">
              <label className="ad-field__label" htmlFor={`${uid}-${step.id}-sens`}><span>Sensitive input keys</span></label>
              <input
                id={`${uid}-${step.id}-sens`}
                className="ad-input"
                aria-label={`Sensitive keys for ${step.workflowPath}`}
                placeholder="Comma-separated, e.g. api_key, deploy_token"
                value={step.sensitiveKeysText}
                onChange={(e) => updateStep(index, { sensitiveKeysText: e.target.value })}
              />
              <span className="ad-field__help">Values for these keys are masked and never stored.</span>
            </div>

            <div className="ad-field ad-planedit__inputs">
              <span className="ad-field__label"><span>Inputs</span></span>
              {step.definition.status === "loading" && (
                <span className="ad-field__help" role="status">Loading inputs from {step.definition.ref}…</span>
              )}
              {step.definition.status === "loaded" && step.definition.inputs.length === 0 && (
                <span className="ad-field__help">This workflow takes no inputs.</span>
              )}
              {step.definition.status === "loaded" && step.definition.inputs.map((input) => (
                <DispatchField
                  key={input.name}
                  type={input.type}
                  name={input.name}
                  label={input.name}
                  required={input.required}
                  value={step.values[input.name] ?? input.defaultValue ?? ""}
                  options={input.type === "environment" && step.definition.status === "loaded"
                    ? step.definition.environmentNames
                    : input.options ?? []}
                  description={input.description}
                  defaultValue={input.defaultValue}
                  sensitive={isSensitiveInputName(input.name) || sensitiveKeysFor(step).includes(input.name)}
                  onChange={(value) => patchStepById(step.id, (current) => ({ values: { ...current.values, [input.name]: value } }))}
                />
              ))}
              {step.definition.status === "unavailable" && (
                <span className="ad-field__help" role="status">
                  Could not read this workflow's inputs ({step.definition.reason}). Enter them by name instead.
                </span>
              )}
              {step.definition.status === "unavailable" && step.inputs.length === 0 && (
                <span className="ad-field__help">No inputs added. The workflow's defaults will be used.</span>
              )}
              {step.definition.status === "unavailable" && step.inputs.map((row, rowIndex) => {
                const key = row.key.trim();
                const sensitive = isSensitiveInputName(key) || (key !== "" && sensitiveKeysFor(step).includes(key));
                return (
                  <div key={row.rowId} className="ad-planedit__inputrow">
                    <input
                      className="ad-input"
                      aria-label={`Input ${rowIndex + 1} name for ${step.workflowPath}`}
                      placeholder="Input name"
                      value={row.key}
                      onChange={(e) => updateRow(index, row.rowId, { key: e.target.value })}
                    />
                    <input
                      className="ad-input"
                      aria-label={`Input ${rowIndex + 1} value for ${step.workflowPath}`}
                      type={sensitive ? "password" : "text"}
                      autoComplete="off"
                      placeholder={sensitive ? "Sensitive – masked and not stored" : "Value"}
                      value={row.value}
                      onChange={(e) => updateRow(index, row.rowId, { value: e.target.value })}
                    />
                    <Button
                      variant="ghost"
                      icon="trash"
                      title="Remove input"
                      aria-label={`Remove input ${rowIndex + 1} for ${step.workflowPath}`}
                      onClick={() => removeRow(index, row.rowId)}
                    />
                  </div>
                );
              })}
              {step.definition.status === "unavailable" && (
              <div>
                <Button
                  variant="ghost"
                  icon="add"
                  aria-label={`Add input for ${step.workflowPath}`}
                  disabled={step.inputs.length >= MAX_INPUTS_PER_STEP}
                  onClick={() => addRow(index)}
                >
                  Add input
                </Button>
              </div>
              )}
            </div>

            {step.definition.status === "loaded" && (
              <AutoApproveConsent
                environments={step.definition.environments}
                inputs={definedValues(step)}
                checked={step.autoApprove}
                label={steps.length > 1 ? "this step's run" : "this scheduled run"}
                onChange={(checked) => patchStepById(step.id, () => ({ autoApprove: checked }))}
              />
            )}
          </li>
        ))}
      </ol>

      <footer className="ad-planedit__foot">
        <Button
          variant="primary"
          icon={busy ? undefined : "save"}
          busy={busy}
          disabled={steps.length === 0 || steps.length > MAX_STEPS || steps.some((step) => step.definition.status === "loading")}
          onClick={() => void savePlan()}
        >
          {busy ? "Saving…" : "Save plan"}
        </Button>
      </footer>
    </section>
  );
}
