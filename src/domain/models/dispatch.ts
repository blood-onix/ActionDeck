export const dispatchInputTypes = ["string", "boolean", "choice", "number", "environment"] as const;

export type DispatchInputType = typeof dispatchInputTypes[number];

export interface DispatchInputDefinition {
  readonly name: string;
  readonly type: DispatchInputType;
  readonly description?: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly options?: readonly string[];
  readonly sourceRef: string;
}

export interface DispatchInputValidation {
  readonly valid: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * A job-level deployment environment declared in a workflow. `name` is set when the YAML names the
 * environment literally; otherwise `expression` holds the text GitHub evaluates at run time (or a note
 * that the job calls a reusable workflow whose environments are not visible here).
 */
export interface WorkflowEnvironmentRef {
  readonly job: string;
  readonly name?: string;
  readonly expression?: string;
}

export type DispatchTarget =
  | {
    readonly state: "available";
    readonly workflowId: number;
    readonly workflowPath: string;
    readonly ref: string;
    readonly defaultBranch: string;
    readonly inputs: readonly DispatchInputDefinition[];
    readonly environments?: readonly WorkflowEnvironmentRef[];
  }
  | {
    readonly state: "blocked";
    readonly workflowId: number;
    readonly workflowPath?: string;
    readonly ref: string;
    readonly defaultBranch?: string;
    readonly reason: string;
  };

/** Remote branch names offered as dispatch refs; any other ref can still be typed. */
export interface BranchInventory {
  readonly names: readonly string[];
  readonly truncated: boolean;
}

export type EnvironmentInventory =
  | { readonly state: "loaded"; readonly names: readonly string[] }
  | { readonly state: "partial"; readonly names: readonly string[]; readonly manualEntryAllowed: true }
  | { readonly state: "permission_restricted"; readonly reason: string; readonly manualEntryAllowed: true }
  | { readonly state: "unavailable"; readonly reason: string; readonly manualEntryAllowed: false };
