import { useEffect, useState } from "react";
import type { AutoApprovalRule } from "../../../src/domain/models/approval";
import type { Bridge } from "../bridge";

export interface ApprovalAuditView {
  timestamp: number;
  runId: number;
  workflowId: number;
  environmentName: string;
  status: string;
  error?: string;
}

export interface RuleWorkflowOption {
  workflowId: number;
  name: string;
}

const NO_RULES: readonly AutoApprovalRule[] = [];
const NO_AUDIT: readonly ApprovalAuditView[] = [];
const NO_WORKFLOWS: readonly RuleWorkflowOption[] = [];

export function ApprovalRules({
  bridge,
  initialRules = NO_RULES,
  audit = NO_AUDIT,
  workflows = NO_WORKFLOWS,
}: {
  bridge: Bridge;
  initialRules?: readonly AutoApprovalRule[];
  audit?: readonly ApprovalAuditView[];
  workflows?: readonly RuleWorkflowOption[];
}) {
  const [rules, setRules] = useState<AutoApprovalRule[]>([...initialRules]);
  const [workflowId, setWorkflowId] = useState(workflows[0] ? String(workflows[0].workflowId) : "");
  const [environmentName, setEnvironmentName] = useState("");
  const [ref, setRef] = useState("main");
  const [error, setError] = useState("");

  useEffect(() => setRules([...initialRules]), [initialRules]);
  useEffect(() => {
    if (!workflowId && workflows[0]) setWorkflowId(String(workflows[0].workflowId));
  }, [workflows, workflowId]);

  const workflowLabel = (id: number) => workflows.find((item) => item.workflowId === id)?.name ?? `Workflow #${id}`;
  const parsedWorkflowId = Number(workflowId);
  const canSave = Number.isInteger(parsedWorkflowId) && parsedWorkflowId > 0 && environmentName.trim() !== "" && ref.trim() !== "";

  async function saveRule() {
    setError("");
    try {
      const saved = await bridge.request<AutoApprovalRule>("approvalRule.save", {
        id: `rule-${Date.now()}`,
        workflowId: parsedWorkflowId,
        environmentName: environmentName.trim(),
        ref: ref.trim(),
        enabled: false,
      });
      setRules((prev) => [...prev.filter((r) => r.id !== saved.id), saved]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function toggleRule(rule: AutoApprovalRule) {
    setError("");
    try {
      const updated = await bridge.request<AutoApprovalRule>("approvalRule.setEnabled", {
        ruleId: rule.id,
        enabled: !rule.enabled,
      });
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section aria-label="Auto-Approval Rules" className="ad-card" style={{ marginTop: "var(--space-5)" }}>
      <h4 className="ad-section">Opt-in auto-approval rules (disabled by default)</h4>
      <p className="ad-caption ad-muted">
        Rules only match your own runs on exact repository, workflow, environment, and ref. GitHub protection rules remain authoritative.
      </p>
      {error && <div role="alert" className="ad-field__error">{error}</div>}
      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        {workflows.length > 0
          ? <select className="ad-input" style={{ flex: "1 1 140px" }} aria-label="Rule workflow" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {workflows.map((item) => <option key={item.workflowId} value={item.workflowId}>{item.name}</option>)}
          </select>
          : <input className="ad-input" style={{ flex: "1 1 120px" }} placeholder="Workflow ID" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} />}
        <input className="ad-input" style={{ flex: "1 1 120px" }} placeholder="Environment" value={environmentName} onChange={(e) => setEnvironmentName(e.target.value)} />
        <input className="ad-input" style={{ flex: "1 1 100px" }} placeholder="Ref" value={ref} onChange={(e) => setRef(e.target.value)} />
        <button className="ad-btn" disabled={!canSave} onClick={() => void saveRule()}>Create rule (disabled)</button>
      </div>
      {canSave && (
        <p className="muted" aria-label="Rule setup summary">
          Summary: when a run of <strong>{workflowLabel(parsedWorkflowId)}</strong> that you started on ref{" "}
          <strong>{ref.trim()}</strong> waits for environment <strong>{environmentName.trim()}</strong>, ActionDeck will
          approve it automatically. The rule starts disabled, applies only to this repository and your account, never uses
          AI, and stops acting if your GitHub identity changes.
        </p>
      )}
      <ul>
        {rules.map((rule) => (
          <li key={rule.id}>
            {workflowLabel(rule.workflowId)} · {rule.environmentName} · {rule.ref} —{" "}
            <strong>{rule.enabled ? "Enabled" : "Disabled"}</strong>
            <button onClick={() => void toggleRule(rule)}>
              {rule.enabled ? "Disable" : "Enable"}
            </button>
          </li>
        ))}
      </ul>
      {audit.length > 0 && (
        <>
          <h5>Recent auto-approval outcomes</h5>
          <ul aria-label="Auto-approval audit">
            {[...audit].reverse().map((entry, index) => (
              <li key={`${entry.timestamp}:${entry.runId}:${index}`}>
                {new Date(entry.timestamp).toLocaleString()} · {workflowLabel(entry.workflowId)} · run #{entry.runId} ·{" "}
                {entry.environmentName}: {entry.status}
                {entry.error ? ` (${entry.error})` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
