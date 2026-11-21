import type { DispatchInputDefinition, DispatchTarget } from "../models/dispatch";
import type {
  BatchCompatibilityReport,
  BatchFieldCompatibility,
  BatchTargetResolution,
  DefaultDecision,
  InputConflictKind,
} from "../models/batch";
import { validateRemoteDispatchInputs } from "../../application/dispatch/dispatch-validation";

export function analyzeBatchInputCompatibility(
  targets: readonly DispatchTarget[],
): BatchCompatibilityReport {
  const byName = new Map<string, DispatchInputDefinition[]>();
  for (const target of targets) {
    if (target.state !== "available") continue;
    for (const input of target.inputs) {
      const list = byName.get(input.name) ?? [];
      list.push(input);
      byName.set(input.name, list);
    }
  }

  const fields: BatchFieldCompatibility[] = [];
  for (const [name, defs] of byName.entries()) {
    const types = [...new Set(defs.map((d) => d.type))];
    const requiredFlags = [...new Set(defs.map((d) => d.required))];
    const defaults = [...new Set(defs.map((d) => d.defaultValue ?? ""))];
    const conflicts: InputConflictKind[] = [];

    if (types.length > 1) conflicts.push("type_mismatch");
    if (requiredFlags.length > 1) conflicts.push("required_mismatch");

    if (types[0] === "choice") {
      const optionSets = defs.map((d) => [...(d.options ?? [])].sort().join("\0"));
      if (new Set(optionSets).size > 1) conflicts.push("options_mismatch");
    }

    const hasDifferentDefaults = defaults.length > 1;
    if (hasDifferentDefaults && conflicts.length > 0) {
      conflicts.push("default_mismatch");
    }

    const compatible = conflicts.length === 0;
    const first = defs[0];
    fields.push({
      name,
      compatible,
      conflicts,
      hasDifferentDefaults,
      types,
      required: defs.some((d) => d.required),
      ...(defaults.length === 1 && defaults[0] !== "" ? { sharedDefault: defaults[0] } : {}),
      ...(compatible && first?.type === "choice" && first.options ? { options: first.options } : {}),
    });
  }

  return { fields };
}

export function resolveBatchTargets(
  targets: readonly DispatchTarget[],
  input: {
    sharedInputs: Readonly<Record<string, string>>;
    defaultDecisions: Readonly<Record<string, DefaultDecision>>;
    perWorkflowOverrides: Readonly<Record<number, Readonly<Record<string, string>>>>;
  },
): BatchTargetResolution[] {
  const report = analyzeBatchInputCompatibility(targets);
  for (const field of report.fields) {
    if (
      field.compatible &&
      field.hasDifferentDefaults &&
      input.sharedInputs[field.name] === undefined &&
      !input.defaultDecisions[field.name]
    ) {
      throw new Error(
        `Input '${field.name}' has different default values across workflows; choose a shared value or retain each workflow's default.`,
      );
    }
  }

  return targets.map((target) => {
    if (target.state !== "available") {
      return {
        workflowId: target.workflowId,
        workflowPath: target.workflowPath ?? "",
        ref: target.ref,
        effectiveInputs: {},
        valid: false,
        errors: { _form: target.reason },
      };
    }

    const overrides = input.perWorkflowOverrides[target.workflowId] ?? {};
    const merged: Record<string, string> = {};
    for (const def of target.inputs) {
      const fieldReport = report.fields.find((f) => f.name === def.name);
      const overrideVal = overrides[def.name];
      const sharedVal = input.sharedInputs[def.name];
      if (overrideVal !== undefined) {
        merged[def.name] = overrideVal;
      } else if (
        fieldReport?.compatible &&
        sharedVal !== undefined &&
        input.defaultDecisions[def.name] !== "retain_workflow_defaults"
      ) {
        merged[def.name] = sharedVal;
      } else if (def.defaultValue !== undefined) {
        merged[def.name] = def.defaultValue;
      }
    }

    const validation = validateRemoteDispatchInputs(target, merged);
    return {
      workflowId: target.workflowId,
      workflowPath: target.workflowPath,
      ref: target.ref,
      effectiveInputs: validation.values,
      valid: validation.valid,
      errors: validation.errors,
    };
  });
}
