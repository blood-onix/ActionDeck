import type { WorkflowEnvironmentRef } from "../models/dispatch";

/**
 * Which environment gates a one-run auto-approval covers. `environments: null` means every gate the run
 * waits on, used when at least one environment is only known at run time.
 */
export interface AutoApprovalScope {
  readonly environments: readonly string[] | null;
  readonly unresolved: readonly string[];
}

const inputReference = /\$\{\{\s*(?:github\.event\.)?inputs(?:\.([A-Za-z_][\w-]*)|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\])\s*\}\}/g;

/**
 * Resolves the environment names a dispatch will hit, substituting `${{ inputs.X }}` references with the
 * values being dispatched. Anything else GitHub evaluates at run time stays unresolved.
 */
export function resolveAutoApprovalScope(
  refs: readonly WorkflowEnvironmentRef[],
  inputs: Readonly<Record<string, string>>,
): AutoApprovalScope {
  const names = new Map<string, string>();
  const unresolved: string[] = [];
  for (const ref of refs) {
    if (ref.name !== undefined) {
      names.set(ref.name.toLowerCase(), ref.name);
      continue;
    }
    const expression = ref.expression ?? "";
    let missing = false;
    const substituted = expression.replace(inputReference, (_match, dotted?: string, single?: string, double?: string) => {
      const value = inputs[dotted ?? single ?? double ?? ""];
      if (value === undefined || value.trim() === "") missing = true;
      return value ?? "";
    });
    const resolved = substituted.trim();
    if (missing || resolved === "" || resolved.includes("${{") || expression === "reusable workflow") {
      unresolved.push(`${ref.job}: ${expression}`);
    } else {
      names.set(resolved.toLowerCase(), resolved);
    }
  }
  return {
    environments: unresolved.length > 0 ? null : [...names.values()],
    unresolved,
  };
}

/** GitHub environment names are case-insensitive. */
export function scopeCoversEnvironment(scope: readonly string[] | null, environmentName: string): boolean {
  if (scope === null) return true;
  const wanted = environmentName.toLowerCase();
  return scope.some((name) => name.toLowerCase() === wanted);
}
