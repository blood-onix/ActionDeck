import { describe, expect, it, vi } from "vitest";
import { executeRunAction } from "../../src/application/runs/run-actions";
import { UiAuthorization } from "../../src/application/dispatch/authorization";

const repository = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({
          data: { id: 8, run_attempt: 2, status: "completed", conclusion: "failure" },
        }),
        cancelWorkflowRun: vi.fn().mockResolvedValue({ status: 202 }),
        reRunWorkflowFailedJobs: vi.fn().mockResolvedValue({ status: 201 }),
        ...overrides,
      },
    },
  };
}

function authorize(action: "cancel" | "rerun_failed_jobs", runId = 8, attempt = 2) {
  const authorization = new UiAuthorization();
  authorization.authorize({
    repositoryId: repository.id,
    target: `${action}:run:${runId}:attempt:${attempt}`,
    ref: "",
    inputs: {},
  });
  return authorization;
}

describe("manual run actions", () => {
  it("binds a mutation to the exact authorized repository, action, run, and attempt", async () => {
    const client = fakeClient({
      getWorkflowRun: vi.fn().mockResolvedValue({
        data: { id: 8, run_attempt: 2, status: "in_progress", conclusion: null },
      }),
    });
    await expect(executeRunAction(client, repository, authorize("cancel"), {
      action: "cancel",
      runId: 8,
      attempt: 2,
    })).resolves.toEqual({ state: "accepted" });
    expect(client.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith({
      owner: "acme",
      repo: "demo",
      run_id: 8,
    });
    await expect(executeRunAction(client, repository, authorize("cancel"), {
      action: "rerun_failed_jobs",
      runId: 8,
      attempt: 2,
    })).rejects.toMatchObject({ code: "permission_restricted" });
    expect(client.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });

  it("revalidates the live attempt before invoking the authorized mutation", async () => {
    const client = fakeClient({
      getWorkflowRun: vi.fn().mockResolvedValue({
        data: { id: 8, run_attempt: 3, status: "completed", conclusion: "failure" },
      }),
    });
    await expect(executeRunAction(client, repository, authorize("rerun_failed_jobs"), {
      action: "rerun_failed_jobs",
      runId: 8,
      attempt: 2,
    })).rejects.toMatchObject({ code: "stale" });
    expect(client.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });

  it("never resends an uncertain mutation and reports an explicit uncertain outcome", async () => {
    const client = fakeClient({
      reRunWorkflowFailedJobs: vi.fn().mockRejectedValue(new TypeError("network disconnected")),
      getWorkflowRun: vi.fn()
        .mockResolvedValueOnce({ data: { id: 8, run_attempt: 2, status: "completed", conclusion: "failure" } })
        .mockRejectedValueOnce(new TypeError("network unavailable")),
    });
    const result = await executeRunAction(client, repository, authorize("rerun_failed_jobs"), {
      action: "rerun_failed_jobs",
      runId: 8,
      attempt: 2,
    });
    expect(result).toEqual({ state: "outcome_uncertain", reconciliation: "unavailable" });
    expect(client.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledOnce();
    expect(client.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(2);
  });
});
