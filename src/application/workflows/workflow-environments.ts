import { isMap, isNode, isScalar, parseDocument, type Node } from "yaml";
import type { WorkflowEnvironmentRef } from "../../domain/models/dispatch";

const maximumJobs = 100;
const maximumEnvironmentNameLength = 255;

/**
 * Lists the deployment environments each job of a workflow targets. Jobs that call a reusable workflow
 * are reported with an expression note, because the environments they use live in another file.
 */
export function parseWorkflowEnvironments(source: string): WorkflowEnvironmentRef[] {
  const document = parseDocument(source, { version: "1.2", uniqueKeys: false });
  if (document.errors.length > 0 || !isMap(document.contents)) return [];
  const jobs = valueFor(document.contents, "jobs");
  if (!isMap(jobs)) return [];

  const refs: WorkflowEnvironmentRef[] = [];
  for (const item of jobs.items.slice(0, maximumJobs)) {
    if (!isScalar(item.key) || typeof item.key.value !== "string" || !isMap(item.value)) continue;
    const job = item.key.value;
    const environment = valueFor(item.value, "environment");
    const nameNode = isMap(environment) ? valueFor(environment, "name") : environment;
    const name = nameNode === undefined ? undefined : scalarString(nameNode);
    if (name !== undefined && name.trim() !== "" && name.length <= maximumEnvironmentNameLength) {
      refs.push(name.includes("${{") ? { job, expression: name.trim() } : { job, name: name.trim() });
      continue;
    }
    if (valueFor(item.value, "uses") !== undefined) {
      refs.push({ job, expression: "reusable workflow" });
    }
  }
  return refs;
}

function valueFor(map: Node | null | undefined, name: string): Node | undefined {
  if (!isMap(map)) return undefined;
  const pair = map.items.find((item) => isScalar(item.key) && item.key.value === name);
  return pair && isNode(pair.value) ? pair.value : undefined;
}

function scalarString(value: Node): string | undefined {
  if (!isScalar(value) || value.value === null || typeof value.value === "object") return undefined;
  return String(value.value);
}
