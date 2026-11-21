import { describe, expect, it } from "vitest";
import { inspectLocalWorkflowPreview } from "../../src/application/workflows/local-preview";

describe("local workflow preview", () => {
  it("parses local workflow_dispatch inputs without changing execution provenance", () => {
    const preview = inspectLocalWorkflowPreview(
      ".github/workflows/release.yml",
      "on:\n  workflow_dispatch:\n    inputs:\n      version:\n        type: string\n        required: true\n",
    );
    expect(preview.dispatchable).toBe(true);
    expect(preview.inputs).toEqual([{
      name: "version",
      type: "string",
      required: true,
      sourceRef: "local-preview",
    }]);
    expect(preview.warning).toContain("preview-only");
    expect(JSON.stringify(preview)).not.toContain("workflow_dispatch:");
  });

  it("returns an explicit preview-only unavailable state for malformed or non-dispatchable YAML", () => {
    expect(inspectLocalWorkflowPreview(".github/workflows/a.yml", "name: ["))
      .toMatchObject({ dispatchable: false, diagnostic: expect.any(String) });
    expect(inspectLocalWorkflowPreview(".github/workflows/a.yml", "on: push\n"))
      .toMatchObject({ dispatchable: false, diagnostic: expect.any(String) });
  });
});
