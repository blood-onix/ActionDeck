import { describe, expect, it, vi } from "vitest";
import { analyzeBatchInputCompatibility, resolveBatchTargets } from "../../src/domain/services/input-compatibility";
import { executeBatchDispatch } from "../../src/application/dispatch/batch-service";
import type { DispatchTarget } from "../../src/domain/models/dispatch";
import type { DispatchSubmissionRepository } from "../../src/application/dispatch/dispatch-service";
import { UiAuthorization } from "../../src/application/dispatch/authorization";
import { AppError } from "../../src/domain/models/errors";

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

const targets: DispatchTarget[] = [
  {
    state: "available",
    workflowId: 1,
    workflowPath: ".github/workflows/a.yml",
    ref: "main",
    defaultBranch: "main",
    inputs: [
      { name: "env", type: "choice", required: true, options: ["staging", "prod"], defaultValue: "staging", sourceRef: "main" },
      { name: "dry_run", type: "boolean", required: false, defaultValue: "true", sourceRef: "main" },
    ],
  },
  {
    state: "available",
    workflowId: 2,
    workflowPath: ".github/workflows/b.yml",
    ref: "main",
    defaultBranch: "main",
    inputs: [
      { name: "env", type: "choice", required: true, options: ["staging", "qa"], defaultValue: "qa", sourceRef: "main" },
      { name: "dry_run", type: "string", required: false, defaultValue: "true", sourceRef: "main" },
    ],
  },
  {
    state: "available",
    workflowId: 3,
    workflowPath: ".github/workflows/c.yml",
    ref: "main",
    defaultBranch: "main",
    inputs: [
      { name: "env", type: "choice", required: false, options: ["staging", "prod"], defaultValue: "prod", sourceRef: "main" },
    ],
  },
];

describe("Batch input compatibility & bounded execution", () => {
  it("detects type, option, required-flag, and default-value conflicts without silent merging", () => {
    const analysis = analyzeBatchInputCompatibility(targets);
    const envField = analysis.fields.find((f) => f.name === "env");
    const dryRunField = analysis.fields.find((f) => f.name === "dry_run");

    expect(envField?.compatible).toBe(false);
    expect(envField?.conflicts).toContain("options_mismatch");
    expect(envField?.conflicts).toContain("required_mismatch");
    expect(envField?.conflicts).toContain("default_mismatch");

    expect(dryRunField?.compatible).toBe(false);
    expect(dryRunField?.conflicts).toContain("type_mismatch");
  });

  it("requires explicit resolution for differing defaults and preserves per-workflow defaults when chosen", () => {
    const sameShape: DispatchTarget[] = [
      {
        state: "available",
        workflowId: 10,
        workflowPath: ".github/workflows/x.yml",
        ref: "main",
        defaultBranch: "main",
        inputs: [{ name: "region", type: "string", required: false, defaultValue: "us-east", sourceRef: "main" }],
      },
      {
        state: "available",
        workflowId: 11,
        workflowPath: ".github/workflows/y.yml",
        ref: "main",
        defaultBranch: "main",
        inputs: [{ name: "region", type: "string", required: false, defaultValue: "eu-west", sourceRef: "main" }],
      },
    ];
    const analysis = analyzeBatchInputCompatibility(sameShape);
    const region = analysis.fields.find((f) => f.name === "region");
    expect(region?.compatible).toBe(true);
    expect(region?.hasDifferentDefaults).toBe(true);

    expect(() => resolveBatchTargets(sameShape, {
      sharedInputs: {},
      defaultDecisions: {},
      perWorkflowOverrides: {},
    })).toThrow(/default/i);

    const retained = resolveBatchTargets(sameShape, {
      sharedInputs: {},
      defaultDecisions: { region: "retain_workflow_defaults" },
      perWorkflowOverrides: {},
    });
    expect(retained[0]?.effectiveInputs.region).toBe("us-east");
    expect(retained[1]?.effectiveInputs.region).toBe("eu-west");
  });

  it("executes with bounded concurrency, isolates partial failures, and never retries uncertain outcomes", async () => {
    let active = 0;
    let maxActive = 0;
    const submitCalls: number[] = [];
    const repository: DispatchSubmissionRepository = {
      loadTarget: vi.fn().mockImplementation(async (workflowId: number) => ({
        state: "available",
        workflowId,
        workflowPath: `.github/workflows/${workflowId}.yml`,
        ref: "main",
        defaultBranch: "main",
        inputs: [],
      })),
      submit: vi.fn().mockImplementation(async (workflowId: number) => {
        active++;
        maxActive = Math.max(maxActive, active);
        submitCalls.push(workflowId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        if (workflowId === 2) throw new AppError("network", "Connection dropped after request.");
        if (workflowId === 3) throw new AppError("permission_restricted", "Forbidden.");
      }),
      listAssociationCandidates: vi.fn().mockResolvedValue({ runs: [], partial: false }),
    };

    const items = [1, 2, 3, 4].map((workflowId) => ({ workflowId, ref: "main", inputs: {} }));
    const authorization = new UiAuthorization();
    authorization.authorize({
      repositoryId: context.id,
      target: "batch:1,2,3,4",
      ref: "main",
      inputs: { count: "4" },
    });

    const batch = await executeBatchDispatch(repository, context, authorization, items, { concurrency: 2 });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(submitCalls.filter((id) => id === 2)).toHaveLength(1);
    expect(batch.items.find((item) => item.workflowId === 1)?.state).toBe("request_accepted");
    expect(batch.items.find((item) => item.workflowId === 2)?.state).toBe("outcome_uncertain");
    expect(batch.items.find((item) => item.workflowId === 3)?.state).toBe("failed_to_submit");
    expect(batch.items.find((item) => item.workflowId === 4)?.state).toBe("request_accepted");
  });
});
