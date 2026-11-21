import { parseWorkflowDispatchInputs } from "../dispatch/dispatch-validation";
import type { DispatchInputDefinition } from "../../domain/models/dispatch";

export interface LocalWorkflowPreview {
  readonly workflowPath: string;
  readonly dispatchable: boolean;
  readonly diagnostic?: string;
  readonly inputs?: readonly DispatchInputDefinition[];
  readonly warning: "This local YAML is preview-only and will not be executed or uploaded.";
}

export function inspectLocalWorkflowPreview(
  workflowPath: string,
  source: string,
): LocalWorkflowPreview {
  const parsed = parseWorkflowDispatchInputs(source, "local-preview");
  if (parsed.state !== "available") {
    return {
      workflowPath,
      dispatchable: false,
      diagnostic: parsed.reason,
      warning: "This local YAML is preview-only and will not be executed or uploaded.",
    };
  }
  return {
    workflowPath,
    dispatchable: true,
    inputs: parsed.inputs,
    warning: "This local YAML is preview-only and will not be executed or uploaded.",
  };
}
