export type BatchItemState =
  | "not_submitted"
  | "submitting"
  | "request_accepted"
  | "associated_run_found"
  | "running"
  | "completed"
  | "failed_to_submit"
  | "outcome_uncertain";

export type DefaultDecision = "use_shared_value" | "retain_workflow_defaults";

export type InputConflictKind =
  | "type_mismatch"
  | "options_mismatch"
  | "required_mismatch"
  | "default_mismatch";

export interface BatchFieldCompatibility {
  readonly name: string;
  readonly compatible: boolean;
  readonly conflicts: readonly InputConflictKind[];
  readonly hasDifferentDefaults: boolean;
  readonly types: readonly string[];
  readonly required: boolean;
  readonly sharedDefault?: string;
  readonly options?: readonly string[];
}

export interface BatchCompatibilityReport {
  readonly fields: readonly BatchFieldCompatibility[];
}

export interface BatchTargetResolution {
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly ref: string;
  readonly effectiveInputs: Readonly<Record<string, string>>;
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, string>>;
}

export interface BatchItemResult {
  readonly workflowId: number;
  readonly ref: string;
  readonly state: BatchItemState;
  readonly runId?: number;
  readonly htmlUrl?: string;
  readonly conclusion?: string | null;
  readonly submittedAt?: number;
  readonly acceptedAt?: number;
  readonly error?: string;
}

export interface BatchExecutionResult {
  readonly batchId: string;
  readonly repositoryId: string;
  readonly items: readonly BatchItemResult[];
}
