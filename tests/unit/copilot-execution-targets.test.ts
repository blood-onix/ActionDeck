import { describe, expect, it, vi } from "vitest";
import {
  currentPlanReview,
  resolveDeploymentReview,
  resolveDispatchAction,
  resolvePlanStart,
  resolveRunAction,
} from "../../src/application/copilot/execution-targets";
import { executeConfirmedCopilotAction } from "../../src/application/copilot/execution-tools";
import { executeDispatch } from "../../src/application/dispatch/dispatch-service";
import { UiAuthorization } from "../../src/application/dispatch/authorization";
import type { DispatchTarget } from "../../src/domain/models/dispatch";
import type { ReleasePlan } from "../../src/domain/models/release-plan";

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

const target: DispatchTarget = {
  state: "available",
  workflowId: 7,
  workflowPath: ".github/workflows/deploy.yml",
  ref: "main",
  defaultBranch: "main",
  inputs: [
    { name: "env", type: "string", required: true, sourceRef: "main" },
    { name: "dry_run", type: "boolean", required: false, defaultValue: "true", sourceRef: "main" },
  ],
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    run_number: 3,
    run_attempt: 2,
    display_title: "Deploy",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/acme/demo/actions/runs/9",
    head_branch: "main",
    ...overrides,
  };
}

function plan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    id: "plan-1",
    name: "Release",
    repositoryId: context.id,
    state: "draft",
    currentStepIndex: 0,
    updatedAt: 1,
    steps: [{
      id: "s1",
      workflowId: 7,
      workflowPath: ".github/workflows/deploy.yml",
      ref: "main",
      inputs: { env: "prod", api_token: "" },
      sensitiveInputKeys: [],
      gate: "on_success",
      state: "pending",
    }],
    ...overrides,
  };
}

describe("Copilot execution target pre-validation", () => {
  it("resolves dispatch effective inputs from the remote definition and binds confirmation and UI authorization to them", async () => {
    const port = { loadTarget: vi.fn().mockResolvedValue(target) };
    const resolved = await resolveDispatchAction(context, port, { workflowId: 7, ref: "main", inputs: { env: "staging" } });
    expect(resolved.proposal.effectiveParameters).toEqual({ env: "staging", dry_run: "true" });
    expect(resolved.proposal.targetLabel).toContain(".github/workflows/deploy.yml");

    const confirm = vi.fn().mockResolvedValue({ approved: true });
    const submit = vi.fn().mockResolvedValue(undefined);
    const repository = {
      loadTarget: port.loadTarget,
      submit,
      listAssociationCandidates: vi.fn().mockResolvedValue({ runs: [], partial: false }),
    };
    const outcome = await executeConfirmedCopilotAction(context, resolved.proposal, { confirm }, (bound) => {
      const auth = new UiAuthorization();
      auth.authorize(resolved.reviewed);
      return executeDispatch(repository, context, auth, { workflowId: 7, ref: bound.refOrEnvironment, inputs: bound.effectiveParameters });
    });
    expect(outcome.executed).toBe(true);
    expect(submit).toHaveBeenCalledWith(7, "main", { env: "staging", dry_run: "true" }, undefined);
    const shown = confirm.mock.calls[0]![0];
    expect(Object.isFrozen(shown)).toBe(true);
    expect(Object.isFrozen(shown.effectiveParameters)).toBe(true);
  });

  it("rejects blocked or invalid dispatch targets before any confirmation", async () => {
    await expect(resolveDispatchAction(context, {
      loadTarget: vi.fn().mockResolvedValue({ state: "blocked", workflowId: 7, ref: "main", reason: "No workflow_dispatch trigger." }),
    }, { workflowId: 7, ref: "main", inputs: {} })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolveDispatchAction(context, { loadTarget: vi.fn().mockResolvedValue(target) }, {
      workflowId: 7, ref: "main", inputs: {},
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fails the exact-match authorization when the remote definition changes after confirmation", async () => {
    const resolved = await resolveDispatchAction(context, { loadTarget: vi.fn().mockResolvedValue(target) }, {
      workflowId: 7, ref: "main", inputs: { env: "staging" },
    });
    const changed: DispatchTarget = { ...target, inputs: target.inputs.slice(0, 1) };
    const submit = vi.fn();
    const auth = new UiAuthorization();
    auth.authorize(resolved.reviewed);
    await expect(executeDispatch({
      loadTarget: vi.fn().mockResolvedValue(changed),
      submit,
      listAssociationCandidates: vi.fn(),
    }, context, auth, { workflowId: 7, ref: "main", inputs: resolved.proposal.effectiveParameters }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(submit).not.toHaveBeenCalled();

    const mismatched = new UiAuthorization();
    mismatched.authorize({ ...resolved.reviewed, ref: "release" });
    await expect(executeDispatch({
      loadTarget: vi.fn().mockResolvedValue(target),
      submit,
      listAssociationCandidates: vi.fn(),
    }, context, mismatched, { workflowId: 7, ref: "main", inputs: resolved.proposal.effectiveParameters }))
      .rejects.toMatchObject({ code: "permission_restricted" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("validates run attempt and state for cancel and rerun", async () => {
    const getRun = vi.fn().mockResolvedValue(run());
    const rerun = await resolveRunAction(context, { getRun }, { action: "rerun_failed_jobs", runId: 9, attempt: 2 });
    expect(rerun.reviewed.target).toBe("rerun_failed_jobs:run:9:attempt:2");
    await expect(resolveRunAction(context, { getRun }, { action: "rerun_failed_jobs", runId: 9, attempt: 1 }))
      .rejects.toMatchObject({ code: "stale" });
    await expect(resolveRunAction(context, { getRun }, { action: "cancel", runId: 9, attempt: 2 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolveRunAction(context, { getRun: vi.fn().mockResolvedValue(run({ status: "in_progress", conclusion: null })) },
      { action: "rerun_failed_jobs", runId: 9, attempt: 2 })).rejects.toMatchObject({ code: "invalid_input" });
    const cancel = await resolveRunAction(context, { getRun: vi.fn().mockResolvedValue(run({ status: "in_progress", conclusion: null })) },
      { action: "cancel", runId: 9, attempt: 2 });
    expect(cancel.proposal.effectiveParameters).toMatchObject({ action: "cancel", runStatus: "in_progress" });
  });

  it("validates pending deployment environments and reviewer eligibility", async () => {
    const getRun = vi.fn().mockResolvedValue(run({ status: "waiting", conclusion: null }));
    const listPendingDeployments = vi.fn().mockResolvedValue([
      { environmentId: 12, environmentName: "staging", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
      { environmentId: 13, environmentName: "prod", eligible: false, currentUserCanApprove: true, waitTimerRemainingSeconds: 30, reason: "Wait timer active (30s remaining)." },
      { environmentId: 14, environmentName: "secure", eligible: false, currentUserCanApprove: false, waitTimerRemainingSeconds: 0 },
    ]);
    const port = { listPendingDeployments };
    const ok = await resolveDeploymentReview(context, { getRun }, port, { runId: 9, environmentIds: [12, 12], state: "approved", comment: "ship" });
    expect(ok.environmentIds).toEqual([12]);
    expect(ok.reviewed).toMatchObject({ target: "review:run:9:envs:12", ref: "approved", inputs: { comment: "ship" } });
    expect(ok.proposal.targetLabel).toContain("staging (#12)");

    await expect(resolveDeploymentReview(context, { getRun }, port, { runId: 9, environmentIds: [13], state: "approved" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolveDeploymentReview(context, { getRun }, port, { runId: 9, environmentIds: [13], state: "rejected" }))
      .resolves.toBeDefined();
    await expect(resolveDeploymentReview(context, { getRun }, port, { runId: 9, environmentIds: [14], state: "rejected" }))
      .rejects.toMatchObject({ code: "permission_restricted" });
    await expect(resolveDeploymentReview(context, { getRun }, port, { runId: 9, environmentIds: [99], state: "rejected" }))
      .rejects.toMatchObject({ code: "stale" });
    await expect(resolveDeploymentReview(context, { getRun: vi.fn().mockResolvedValue(run()) }, port, { runId: 9, environmentIds: [12], state: "approved" }))
      .rejects.toMatchObject({ code: "stale" });
  });

  it("validates persisted plans, refuses sensitive re-entry, masks sensitive values, and detects post-confirmation edits", async () => {
    const stored = plan({ steps: [{ ...plan().steps[0]!, inputs: { env: "prod", dry_run: "false" } }] });
    const lookup = { get: vi.fn().mockReturnValue(stored) };
    const port = { loadTarget: vi.fn().mockResolvedValue(target) };
    const resolved = await resolvePlanStart(context, lookup, port, "plan-1");
    expect(port.loadTarget).toHaveBeenCalledWith(7, "main", undefined);
    expect(resolved.proposal).toMatchObject({ action: "start_plan", refOrEnvironment: "sequential" });
    expect(resolved.proposal.effectiveParameters["steps"]).toContain("env=prod");

    const auth = new UiAuthorization();
    auth.authorize(resolved.reviewed);
    const edited = { ...stored, steps: [{ ...stored.steps[0]!, ref: "release" }] };
    lookup.get.mockReturnValue(edited);
    expect(auth.consume(currentPlanReview(context, lookup, "plan-1"))).toBe(false);

    lookup.get.mockReturnValue(stored);
    const again = new UiAuthorization();
    again.authorize(resolved.reviewed);
    expect(again.consume(currentPlanReview(context, lookup, "plan-1"))).toBe(true);

    const sensitive = plan({ steps: [{ ...plan().steps[0]!, reEntryRequiredKeys: ["api_token"] }] });
    await expect(resolvePlanStart(context, { get: () => sensitive }, port, "plan-1"))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("api_token") });
    await expect(resolvePlanStart(context, { get: () => plan({ state: "running" }) }, port, "plan-1"))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolvePlanStart(context, { get: () => undefined }, port, "plan-1"))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(resolvePlanStart(context, { get: () => plan({ steps: [] }) }, port, "plan-1"))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolvePlanStart(context, { get: () => stored }, { loadTarget: vi.fn().mockResolvedValue({ ...target, inputs: [] }) }, "plan-1"))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("invalid inputs") });
    await expect(resolvePlanStart(context, { get: () => stored }, {
      loadTarget: vi.fn().mockResolvedValue({ state: "blocked", workflowId: 7, ref: "main", reason: "gone" }),
    }, "plan-1")).rejects.toMatchObject({ code: "invalid_input" });
  });
});
