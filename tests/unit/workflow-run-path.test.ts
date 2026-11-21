import { describe, expect, it } from "vitest";
import { workflowPathFromRunPath } from "../../src/domain/services/workflow-run-path";

describe("workflowPathFromRunPath", () => {
  it.each([
    [".github/workflows/plan.yml", ".github/workflows/plan.yml"],
    [".github/workflows/plan.yaml@refs/heads/main", ".github/workflows/plan.yaml"],
    ["acme/demo/.github/workflows/ci.yml@refs/heads/main", ".github/workflows/ci.yml"],
    ["acme/demo/.github/workflows/ci.yml@refs/pull/12/merge", ".github/workflows/ci.yml"],
    ["  .github/workflows/x.yml  ", ".github/workflows/x.yml"],
  ])("extracts the workflow file from %s", (input, expected) => {
    expect(workflowPathFromRunPath(input)).toBe(expected);
  });

  it.each([undefined, null, "", "dynamic/pages/pages-build-deployment", "plan.yml"])(
    "returns undefined for %s",
    (input) => {
      expect(workflowPathFromRunPath(input)).toBeUndefined();
    },
  );
});
