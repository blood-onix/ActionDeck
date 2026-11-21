import { describe, expect, it } from "vitest";
import {
  parseWorkflowDispatchInputs,
  validateDispatchInputs,
  validateRemoteDispatchInputs,
} from "../../src/application/dispatch/dispatch-validation";

const source = `
name: Release
on:
  workflow_dispatch:
    inputs:
      release:
        description: Release label
        required: true
        type: string
      dry_run:
        description: Skip mutations
        type: boolean
        default: true
      region:
        type: choice
        options: [us, eu]
        default: us
      version:
        type: number
        required: true
      target:
        type: environment
        required: true
`;

describe("workflow dispatch input definitions", () => {
  it("parses all supported input types and provenance from YAML 1.2 workflow_dispatch", () => {
    const parsed = parseWorkflowDispatchInputs(source, "refs/heads/release");
    expect(parsed.state).toBe("available");
    if (parsed.state !== "available") return;
    expect(parsed.inputs).toEqual([
      {
        name: "release",
        type: "string",
        description: "Release label",
        required: true,
        sourceRef: "refs/heads/release",
      },
      {
        name: "dry_run",
        type: "boolean",
        description: "Skip mutations",
        required: false,
        defaultValue: "true",
        sourceRef: "refs/heads/release",
      },
      {
        name: "region",
        type: "choice",
        required: false,
        defaultValue: "us",
        options: ["us", "eu"],
        sourceRef: "refs/heads/release",
      },
      {
        name: "version",
        type: "number",
        required: true,
        sourceRef: "refs/heads/release",
      },
      {
        name: "target",
        type: "environment",
        required: true,
        sourceRef: "refs/heads/release",
      },
    ]);
  });

  it("applies defaults, checks required inputs and validates choices and typed values", () => {
    const parsed = parseWorkflowDispatchInputs(source, "main");
    if (parsed.state !== "available") throw new Error("Expected dispatch input definitions.");

    expect(validateDispatchInputs(parsed.inputs, {
      release: "2026.11",
      version: "2",
      target: "production",
    })).toEqual({
      valid: true,
      values: {
        release: "2026.11",
        dry_run: "true",
        region: "us",
        version: "2",
        target: "production",
      },
      errors: {},
    });

    const invalid = validateDispatchInputs(parsed.inputs, {
      release: "",
      region: "apac",
      version: "latest",
      unknown: "ignored?",
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.release).toBeDefined();
    expect(invalid.errors.region).toBeDefined();
    expect(invalid.errors.version).toBeDefined();
    expect(invalid.errors.unknown).toBeDefined();
  });

  it("requires a manual environment name when environment listing is unavailable", () => {
    const parsed = parseWorkflowDispatchInputs(source, "main");
    if (parsed.state !== "available") throw new Error("Expected dispatch input definitions.");
    const result = validateDispatchInputs(parsed.inputs, {
      release: "stable",
      version: "3",
      target: "production/blue",
    });
    expect(result.valid).toBe(true);
    expect(result.values.target).toBe("production/blue");
  });

  it("only validates executable values against the remote definition for the requested ref", () => {
    const parsed = parseWorkflowDispatchInputs(source, "refs/heads/release");
    if (parsed.state !== "available") throw new Error("Expected dispatch input definitions.");
    const target = {
      state: "available" as const,
      workflowId: 7,
      workflowPath: ".github/workflows/release.yml",
      ref: "refs/heads/release",
      defaultBranch: "main",
      inputs: parsed.inputs,
    };
    expect(validateRemoteDispatchInputs(target, { release: "2026.11", version: "2", target: "prod" }).valid)
      .toBe(true);
    expect(validateRemoteDispatchInputs({
      ...target,
      inputs: parsed.inputs.map((input) => ({ ...input, sourceRef: "local-unsaved" })),
    }, { release: "2026.11", version: "2", target: "prod" })).toMatchObject({
      valid: false,
      errors: { _form: expect.stringContaining("remote workflow definition") },
    });
  });

  it("preserves explicit non-dispatchable and invalid-YAML states", () => {
    expect(parseWorkflowDispatchInputs("name: Manual\non: push\n", "main"))
      .toMatchObject({ state: "not_dispatchable" });
    expect(parseWorkflowDispatchInputs("name: [", "main"))
      .toMatchObject({ state: "invalid_yaml" });
  });
});
