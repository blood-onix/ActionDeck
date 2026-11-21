import { useState } from "react";
import type {
  BatchCompatibilityReport,
  BatchItemResult,
  BatchTargetResolution,
  DefaultDecision,
} from "../../../src/domain/models/batch";
import { isSensitiveInputName } from "../../../src/domain/services/plan-transitions";
import type { Bridge } from "../bridge";
import { Button } from "../components/Button";
import { ConflictRow, type ConflictKind } from "../components/ConflictRow";
import { DispatchField } from "../components/DispatchField";
import { StateNotice } from "../components/StateNotice";
import { BatchProgress } from "./BatchProgress";

export interface BatchWorkflowChoice {
  readonly workflowId: number;
  readonly name: string;
  readonly path: string;
  readonly defaultBranch?: string;
}

interface BatchValidationResponse {
  valid: boolean;
  reviewToken?: string;
  compatibility: BatchCompatibilityReport;
  resolvedItems: BatchTargetResolution[];
}

interface BatchSubmitResponse {
  batchId: string;
  items: BatchItemResult[];
}

const MASK = "••••••";

function maskInputs(inputs: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [name, isSensitiveInputName(name) ? MASK : value]),
  );
}

export function BatchForm({
  bridge,
  workflows,
  onClose,
  onInspectRun,
}: {
  bridge: Bridge;
  workflows: readonly BatchWorkflowChoice[];
  onClose(): void;
  onInspectRun?(runId: number): void;
}) {
  const [globalRef, setGlobalRef] = useState(workflows[0]?.defaultBranch ?? "main");
  const [perWorkflowRefs, setPerWorkflowRefs] = useState<Record<number, string>>({});
  const [sharedInputs, setSharedInputs] = useState<Record<string, string>>({});
  const [defaultDecisions, setDefaultDecisions] = useState<Record<string, DefaultDecision>>({});
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, "per_workflow" | "shared">
  >({});
  const [perWorkflowOverrides, setPerWorkflowOverrides] = useState<
    Record<number, Record<string, string>>
  >({});
  const [validation, setValidation] = useState<BatchValidationResponse>();
  const [results, setResults] = useState<BatchItemResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function invalidateReview() {
    setValidation((prev) => {
      if (!prev) return undefined;
      const { reviewToken: _dropped, ...rest } = prev;
      return rest;
    });
  }

  async function reviewBatch() {
    setBusy(true);
    setError("");
    try {
      const response = await bridge.request<BatchValidationResponse>("batch.validate", {
        items: workflows.map((w) => ({
          workflowId: w.workflowId,
          ref: perWorkflowRefs[w.workflowId]?.trim() || globalRef.trim() || "main",
        })),
        sharedInputs,
        defaultDecisions,
        perWorkflowOverrides: Object.fromEntries(
          workflows
            .map((w) => [
              w.workflowId,
              Object.fromEntries(
                Object.entries(perWorkflowOverrides[w.workflowId] ?? {}).filter(
                  ([, value]) => value !== "",
                ),
              ),
            ] as const)
            .filter(([, values]) => Object.keys(values).length > 0),
        ),
      });
      setValidation(response);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function setOverride(workflowId: number, name: string, value: string) {
    setPerWorkflowOverrides((prev) => ({
      ...prev,
      [workflowId]: { ...(prev[workflowId] ?? {}), [name]: value },
    }));
    invalidateReview();
  }

  async function submitBatch() {
    if (!validation?.reviewToken) return;
    setBusy(true);
    setError("");
    try {
      const response = await bridge.request<BatchSubmitResponse>("batch.submit", {
        reviewToken: validation.reviewToken,
        items: validation.resolvedItems.map((item) => ({
          workflowId: item.workflowId,
          ref: item.ref,
          inputs: item.effectiveInputs,
        })),
      });
      setResults(response.items);
      invalidateReview();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const incompatibleFields =
    validation?.compatibility.fields.filter((f) => !f.compatible) ?? [];
  const allConflictsResolved = incompatibleFields.every(
    (f) => conflictResolutions[f.name] !== undefined && conflictResolutions[f.name] !== null,
  );
  const canSubmit = Boolean(validation?.reviewToken) && allConflictsResolved;

  return (
    <section aria-label="Batch workflow dispatch" className="batch-panel">
      {error ? <StateNotice kind="stale" title="Batch validation error" detail={error} inline /> : null}

      <div className="ad-field">
        <label className="ad-field__label" htmlFor="batch-global-ref">
          <span>Global ref</span>
          <code className="ad-field__key ad-mono-sm">ref</code>
        </label>
        <input
          id="batch-global-ref"
          className="ad-input"
          aria-label="Global ref"
          value={globalRef}
          onChange={(e) => {
            setGlobalRef(e.target.value);
            invalidateReview();
          }}
        />
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)", marginBottom: "var(--space-5)" }}>
        {workflows.map((w) => (
          <div key={w.workflowId} style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
            <span className="ad-caption" style={{ flex: "1 1 auto" }}>
              <strong>{w.name}</strong> <span className="ad-mono-sm ad-muted">{w.path}</span>
            </span>
            <input
              className="ad-input"
              style={{ maxWidth: "180px" }}
              aria-label={`Ref for ${w.name}`}
              placeholder={globalRef}
              value={perWorkflowRefs[w.workflowId] ?? ""}
              onChange={(e) => {
                setPerWorkflowRefs((prev) => ({ ...prev, [w.workflowId]: e.target.value }));
                invalidateReview();
              }}
            />
          </div>
        ))}
      </div>

      <div style={{ marginBottom: "var(--space-5)" }}>
        <Button
          variant="secondary"
          busy={busy}
          disabled={workflows.length === 0}
          onClick={() => void reviewBatch()}
        >
          {busy ? "Reviewing…" : "Review batch"}
        </Button>
      </div>

      {validation ? (
        <div className="batch-review">
          <h4 className="ad-section">Compatibility and effective inputs</h4>

          {validation.compatibility.fields.map((field) => {
            if (!field.compatible) {
              const conflictKind: ConflictKind = field.conflicts.some((c) => c.includes("type"))
                ? "type"
                : field.conflicts.some((c) => c.includes("option") || c.includes("choice"))
                  ? "choices"
                  : "default";

              const entries = validation.resolvedItems.map((item) => ({
                workflow: item.workflowPath || `Workflow #${item.workflowId}`,
                type: field.types[0] ?? "string",
                value: item.effectiveInputs[field.name] ?? "—",
              }));

              return (
                <ConflictRow
                  key={field.name}
                  input={field.name}
                  kind={conflictKind}
                  entries={entries}
                  resolution={conflictResolutions[field.name] ?? null}
                  onResolve={(res) => {
                    setConflictResolutions((prev) => ({ ...prev, [field.name]: res }));
                    if (res === "per_workflow") {
                      setDefaultDecisions((prev) => ({
                        ...prev,
                        [field.name]: "retain_workflow_defaults",
                      }));
                    } else {
                      setDefaultDecisions((prev) => ({
                        ...prev,
                        [field.name]: "use_shared_value",
                      }));
                    }
                  }}
                />
              );
            }

            return (
              <div key={field.name}>
                <DispatchField
                  type={(field.types[0] as "string" | "number" | "boolean" | "choice" | "environment") ?? "string"}
                  name={field.name}
                  label={`Shared ${field.name}`}
                  value={sharedInputs[field.name] ?? ""}
                  sensitive={isSensitiveInputName(field.name)}
                  onChange={(val) => {
                    setSharedInputs((prev) => ({ ...prev, [field.name]: val }));
                    invalidateReview();
                  }}
                />
                {field.hasDifferentDefaults ? (
                  <div className="ad-field">
                    <select
                      className="ad-input"
                      aria-label={`Default decision for ${field.name}`}
                      value={defaultDecisions[field.name] ?? ""}
                      onChange={(e) => {
                        const val = e.target.value as DefaultDecision;
                        setDefaultDecisions((prev) => ({ ...prev, [field.name]: val }));
                        invalidateReview();
                      }}
                    >
                      <option value="">Choose default handling…</option>
                      <option value="use_shared_value">Use shared value</option>
                      <option value="retain_workflow_defaults">Retain each workflow default</option>
                    </select>
                  </div>
                ) : null}
              </div>
            );
          })}

          <div style={{ display: "grid", gap: "var(--space-3)", marginBottom: "var(--space-5)" }}>
            {validation.resolvedItems.map((item) => {
              const names = [
                ...new Set([
                  ...Object.keys(item.effectiveInputs),
                  ...Object.keys(item.errors).filter((k) => k !== "_form"),
                  ...Object.keys(perWorkflowOverrides[item.workflowId] ?? {}),
                ]),
              ];
              const label = item.workflowPath || `Workflow #${item.workflowId}`;
              return (
                <div key={item.workflowId} className="ad-card">
                  <div>
                    <strong>{label}</strong> <span className="ad-mono-sm ad-muted">@ {item.ref}</span>
                  </div>
                  <code className="ad-mono-sm">{JSON.stringify(maskInputs(item.effectiveInputs))}</code>
                  {Object.entries(item.errors).map(([k, msg]) => (
                    <div key={k} className="ad-field__error" role="alert">
                      {`[${k}: ${msg}]`}
                    </div>
                  ))}
                  {names.length > 0 ? (
                    <details style={{ marginTop: "var(--space-3)" }}>
                      <summary className="ad-caption">{`Workflow-specific inputs for ${label}`}</summary>
                      <div style={{ marginTop: "var(--space-3)" }}>
                        {names.map((name) => {
                          const sensitive = isSensitiveInputName(name);
                          return (
                            <label key={name} className="ad-field">
                              <span className="ad-caption">{name}</span>
                              <input
                                className="ad-input"
                                aria-label={`Override ${name} for ${label}`}
                                type={sensitive ? "password" : "text"}
                                autoComplete="off"
                                placeholder={
                                  sensitive ? "Masked override" : item.effectiveInputs[name] ?? ""
                                }
                                value={perWorkflowOverrides[item.workflowId]?.[name] ?? ""}
                                onChange={(e) => setOverride(item.workflowId, name, e.target.value)}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <BatchProgress items={results} bridge={bridge} {...(onInspectRun ? { onInspectRun } : {})} />

      <div className="ad-drawer__foot" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          icon="play"
          busy={busy}
          disabled={!canSubmit}
          onClick={() => void submitBatch()}
        >
          {`Run selected (${workflows.length})`}
        </Button>
      </div>
    </section>
  );
}
