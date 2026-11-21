import { isMap, isNode, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type {
  DispatchInputDefinition,
  DispatchInputType,
  DispatchInputValidation,
  DispatchTarget,
} from "../../domain/models/dispatch";
import { dispatchInputTypes } from "../../domain/models/dispatch";

export type DispatchInputParseResult =
  | { readonly state: "available"; readonly inputs: readonly DispatchInputDefinition[] }
  | { readonly state: "not_dispatchable" | "invalid_yaml" | "invalid_definition"; readonly reason: string };

const maximumInputs = 25;
const maximumInputValueLength = 65_535;
const maximumEnvironmentNameLength = 255;

export function parseWorkflowDispatchInputs(source: string, sourceRef: string): DispatchInputParseResult {
  const document = parseDocument(source, { version: "1.2", uniqueKeys: false });
  if (document.errors.length > 0) {
    return { state: "invalid_yaml", reason: "The workflow YAML could not be parsed." };
  }
  if (!isMap(document.contents)) {
    return { state: "invalid_yaml", reason: "The workflow YAML must contain a mapping at its root." };
  }
  const on = valueFor(document.contents, "on");
  if (!isMap(on)) {
    return { state: "not_dispatchable", reason: "The workflow has no workflow_dispatch trigger." };
  }
  const trigger = valueFor(on, "workflow_dispatch");
  if (trigger === undefined) {
    return { state: "not_dispatchable", reason: "The workflow has no workflow_dispatch trigger." };
  }
  if (sourceRef.trim().length === 0) {
    return { state: "invalid_definition", reason: "The workflow definition has no source ref." };
  }
  if (trigger === null) return { state: "available", inputs: [] };
  if (!isMap(trigger)) {
    return { state: "invalid_definition", reason: "workflow_dispatch must be a mapping when it declares inputs." };
  }
  const inputNode = valueFor(trigger, "inputs");
  if (inputNode === undefined) return { state: "available", inputs: [] };
  if (!isMap(inputNode)) {
    return { state: "invalid_definition", reason: "workflow_dispatch inputs must be a mapping." };
  }
  if (inputNode.items.length > maximumInputs) {
    return { state: "invalid_definition", reason: `A workflow may define at most ${maximumInputs} dispatch inputs.` };
  }

  const inputs: DispatchInputDefinition[] = [];
  for (const item of inputNode.items) {
    if (!isScalar(item.key) || typeof item.key.value !== "string" ||
        item.key.value.trim().length === 0 || item.key.value.length > 128) {
      return { state: "invalid_definition", reason: "A dispatch input has an invalid name." };
    }
    if (!isMap(item.value)) {
      return { state: "invalid_definition", reason: `Input "${item.key.value}" must be a mapping.` };
    }
    const typeNode = valueFor(item.value, "type");
    const type = typeNode === undefined ? "string" : scalarString(typeNode);
    if (!isDispatchInputType(type)) {
      return { state: "invalid_definition", reason: `Input "${item.key.value}" has an unsupported type.` };
    }
    const requiredNode = valueFor(item.value, "required");
    const required = requiredNode === undefined ? false : scalarBoolean(requiredNode);
    if (required === undefined) {
      return { state: "invalid_definition", reason: `Input "${item.key.value}" has an invalid required flag.` };
    }
    const descriptionNode = valueFor(item.value, "description");
    const description = descriptionNode === undefined ? undefined : scalarString(descriptionNode);
    if (descriptionNode !== undefined && description === undefined) {
      return { state: "invalid_definition", reason: `Input "${item.key.value}" has an invalid description.` };
    }
    const defaultNode = valueFor(item.value, "default");
    const defaultValue = defaultNode === undefined ? undefined : scalarString(defaultNode);
    if (defaultNode !== undefined && defaultValue === undefined) {
      return { state: "invalid_definition", reason: `Input "${item.key.value}" has an invalid default.` };
    }
    const optionsNode = valueFor(item.value, "options");
    const options = optionsNode === undefined ? undefined : stringSequence(optionsNode);
    if (optionsNode !== undefined && (!options || options.length === 0 || new Set(options).size !== options.length)) {
      return { state: "invalid_definition", reason: `Choice input "${item.key.value}" has invalid options.` };
    }
    if (type === "choice" && !options) {
      return { state: "invalid_definition", reason: `Choice input "${item.key.value}" must declare options.` };
    }
    if (type !== "choice" && options !== undefined) {
      return { state: "invalid_definition", reason: `Only choice inputs may declare options ("${item.key.value}").` };
    }
    inputs.push({
      name: item.key.value,
      type: type as DispatchInputType,
      ...(description === undefined ? {} : { description }),
      required,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(options === undefined ? {} : { options }),
      sourceRef,
    });
  }
  return { state: "available", inputs };
}

export function validateDispatchInputs(
  definitions: readonly DispatchInputDefinition[],
  providedValues: Readonly<Record<string, string>>,
): DispatchInputValidation {
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  const knownNames = new Set(definitions.map((definition) => definition.name));
  for (const name of Object.keys(providedValues)) {
    if (!knownNames.has(name)) errors[name] = "This input is not defined by the remote workflow.";
  }
  for (const definition of definitions) {
    const value = providedValues[definition.name] ?? definition.defaultValue;
    if (value === undefined) {
      if (definition.required) errors[definition.name] = "This input is required.";
      continue;
    }
    if (typeof value !== "string" || value.length > maximumInputValueLength) {
      errors[definition.name] = "Input value is invalid or too long.";
      continue;
    }
    if (definition.required && value.trim().length === 0) {
      errors[definition.name] = "This input is required.";
      continue;
    }
    if (definition.type === "boolean" && value !== "true" && value !== "false") {
      errors[definition.name] = "Choose true or false.";
      continue;
    }
    if (definition.type === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) {
      errors[definition.name] = "Enter a valid number.";
      continue;
    }
    if (definition.type === "choice" && !definition.options?.includes(value)) {
      errors[definition.name] = "Choose one of the available options.";
      continue;
    }
    if (definition.type === "environment" &&
        (value.length > maximumEnvironmentNameLength || /[\u0000-\u001f\u007f]/.test(value))) {
      errors[definition.name] = "Enter a valid environment name.";
      continue;
    }
    values[definition.name] = value;
  }
  const payloadSize = new TextEncoder().encode(JSON.stringify(values)).byteLength;
  if (payloadSize > maximumInputValueLength) {
    errors._form = "Combined dispatch inputs exceed the supported size.";
  }
  return { valid: Object.keys(errors).length === 0, values, errors };
}

export function validateRemoteDispatchInputs(
  target: DispatchTarget,
  providedValues: Readonly<Record<string, string>>,
): DispatchInputValidation {
  if (target.state !== "available") {
    return { valid: false, values: {}, errors: { _form: target.reason } };
  }
  if (target.inputs.some((input) => input.sourceRef !== target.ref)) {
    return {
      valid: false,
      values: {},
      errors: { _form: "Dispatch inputs must come from the remote workflow definition on the selected ref." },
    };
  }
  return validateDispatchInputs(target.inputs, providedValues);
}

function isDispatchInputType(value: string | undefined): value is DispatchInputType {
  return value !== undefined && dispatchInputTypes.some((type) => type === value);
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

function scalarBoolean(value: Node): boolean | undefined {
  if (!isScalar(value) || typeof value.value !== "boolean") return undefined;
  return value.value;
}

function stringSequence(value: Node): string[] | undefined {
  if (!isSeq(value)) return undefined;
  const values: string[] = [];
  for (const item of value.items) {
    if (!isNode(item)) return undefined;
    const parsed = scalarString(item);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return values;
}
