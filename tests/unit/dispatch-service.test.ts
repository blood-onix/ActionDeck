import { describe, expect, it, vi } from "vitest";
import { checkDispatchAssociation, executeDispatch } from "../../src/application/dispatch/dispatch-service";
import { UiAuthorization } from "../../src/application/dispatch/authorization";
import type { DispatchTarget } from "../../src/domain/models/dispatch";
import type { WorkflowRunRecord } from "../../src/domain/models/run";

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};
const now = Date.parse("2026-11-14T00:00:00Z");
const target: DispatchTarget = {
  state: "available",
  workflowId: 7,
  workflowPath: ".github/workflows/release.yml",
  ref: "main",
  defaultBranch: "main",
  inputs: [{
    name: "version",
    type: "string",
    required: true,
    sourceRef: "main",
  }],
};
const request = { workflowId: 7, ref: "main", inputs: { version: "2.0" } };

function run(): WorkflowRunRecord {
  return {
    id: 21,
    workflowId: 7,
    attemptCount: 1,
    hydration: "summary",
    displayTitle: "Release",
    status: "queued",
    conclusion: null,
    event: "workflow_dispatch",
    branch: "main",
    headSha: "abc",
    actor: { id: 42, login: "roman" },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    htmlUrl: "https://github.com/acme/demo/actions/runs/21",
  };
}

function authorization(inputs = request.inputs) {
  const result = new UiAuthorization();
  result.authorize({
    repositoryId: context.id,
    target: "workflow:7",
    ref: "main",
    inputs,
  });
  return result;
}

function fakeRepository(overrides: Record<string, unknown> = {}) {
  return {
    loadTarget: vi.fn().mockResolvedValue(target),
    submit: vi.fn().mockResolvedValue(undefined),
    listAssociationCandidates: vi.fn().mockResolvedValue({ runs: [], partial: false }),
    ...overrides,
  };
}

describe("workflow dispatch service", () => {
  it("submits the exact reviewed effective values and distinguishes an observed run", async () => {
    const repository = fakeRepository({
      listAssociationCandidates: vi.fn().mockResolvedValue({ runs: [run()], partial: false }),
    });
    const result = await executeDispatch(
      repository,
      context,
      authorization(),
      request,
      { now: () => now },
    );

    expect(result).toEqual({
      state: "associated_run_found",
      runId: 21,
      runStatus: "queued",
      htmlUrl: "https://github.com/acme/demo/actions/runs/21",
    });
    expect(repository.submit).toHaveBeenCalledOnce();
    expect(repository.submit).toHaveBeenCalledWith(7, "main", { version: "2.0" }, undefined);
  });

  it("keeps a successful dispatch request in the accepted state until a run is observed", async () => {
    const repository = fakeRepository();
    await expect(executeDispatch(
      repository,
      context,
      authorization(),
      request,
      { now: () => now },
    )).resolves.toEqual({
      state: "request_accepted",
      association: "not_observed",
      submittedAt: now,
      acceptedAt: now,
    });
  });

  it("supports a later read-only association check after acceptance", async () => {
    const repository = fakeRepository({
      listAssociationCandidates: vi.fn().mockResolvedValue({ runs: [run()], partial: false }),
    });
    await expect(checkDispatchAssociation(repository, context, {
      workflowId: 7,
      ref: "main",
      submittedAt: now,
      acceptedAt: now,
    })).resolves.toEqual({
      state: "associated_run_found",
      runId: 21,
      runStatus: "queued",
      htmlUrl: "https://github.com/acme/demo/actions/runs/21",
    });
  });

  it("does not guess when later association candidates are ambiguous or incomplete", async () => {
    const repository = fakeRepository({
      listAssociationCandidates: vi.fn().mockResolvedValue({
        runs: [run(), { ...run(), id: 22 }],
        partial: false,
      }),
    });
    await expect(checkDispatchAssociation(repository, context, {
      workflowId: 7,
      ref: "main",
      submittedAt: now,
      acceptedAt: now,
    })).resolves.toEqual({ state: "outcome_uncertain", reconciliation: "ambiguous" });
    repository.listAssociationCandidates.mockResolvedValue({ runs: [], partial: true });
    await expect(checkDispatchAssociation(repository, context, {
      workflowId: 7,
      ref: "main",
      submittedAt: now,
      acceptedAt: now,
    })).resolves.toEqual({ state: "outcome_uncertain", reconciliation: "ambiguous" });
  });

  it("reconciles an uncertain transport without resending the mutation", async () => {
    const repository = fakeRepository({
      submit: vi.fn().mockRejectedValue(new TypeError("network disconnected")),
    });
    await expect(executeDispatch(
      repository,
      context,
      authorization(),
      request,
      { now: () => now },
    )).resolves.toEqual({ state: "outcome_uncertain", reconciliation: "not_observed" });
    expect(repository.submit).toHaveBeenCalledOnce();
    expect(repository.listAssociationCandidates).toHaveBeenCalledOnce();
  });

  it("does not submit if the authorization no longer matches the effective inputs", async () => {
    const repository = fakeRepository();
    await expect(executeDispatch(
      repository,
      context,
      authorization({ version: "1.0" }),
      request,
      { now: () => now },
    )).rejects.toMatchObject({ code: "permission_restricted" });
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it("blocks inputs from local or otherwise mismatched workflow revisions", async () => {
    const repository = fakeRepository({
      loadTarget: vi.fn().mockResolvedValue({
        ...target,
        inputs: target.state === "available"
          ? target.inputs.map((input) => ({ ...input, sourceRef: "local-unsaved" }))
          : [],
      }),
    });
    await expect(executeDispatch(
      repository,
      context,
      authorization(),
      request,
      { now: () => now },
    )).rejects.toMatchObject({ code: "invalid_input" });
    expect(repository.submit).not.toHaveBeenCalled();
  });
});
