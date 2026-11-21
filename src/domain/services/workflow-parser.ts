import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export interface WorkflowInspection {
  readonly dispatchable: boolean;
  /** True when the workflow can only be invoked from other workflows (`on: workflow_call` alone). */
  readonly reusable: boolean;
  readonly diagnostic?: string;
}

export function inspectWorkflowYaml(source: string): WorkflowInspection {
  const document = parseDocument(source, { version: "1.2", uniqueKeys: false });
  if (document.errors.length > 0) {
    return {
      dispatchable: false,
      reusable: false,
      diagnostic: document.errors.map((error) => error.message).join("; "),
    };
  }
  if (!isMap(document.contents)) return { dispatchable: false, reusable: false };
  const on = document.contents.items.find((item) => isScalar(item.key) && item.key.value === "on")?.value;
  const triggers = triggerNames(on);
  return {
    dispatchable: triggers.includes("workflow_dispatch"),
    reusable: triggers.length > 0 && triggers.every((trigger) => trigger === "workflow_call"),
  };
}

function triggerNames(on: unknown): string[] {
  if (isScalar(on)) return typeof on.value === "string" ? [on.value] : [];
  if (isSeq(on)) {
    return on.items.flatMap((item) => isScalar(item) && typeof item.value === "string" ? [item.value] : []);
  }
  if (isMap(on)) {
    return on.items.flatMap((item) => isScalar(item.key) && typeof item.key.value === "string" ? [item.key.value] : []);
  }
  return [];
}
