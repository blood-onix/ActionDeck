import * as assert from "node:assert";
import { executeBatchDispatch } from "../../src/application/dispatch/batch-service";
import { UiAuthorization } from "../../src/application/dispatch/authorization";
import type { DispatchSubmissionRepository } from "../../src/application/dispatch/dispatch-service";
import { AppError } from "../../src/domain/models/errors";

suite("Batch dispatch integration", () => {
  test("tracks independent item outcomes without retrying uncertain mutations", async () => {
    const context = {
      id: "acme/demo|origin|file:///repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
      authenticatedUserId: "42",
    };
    let dispatches = 0;
    const repository: DispatchSubmissionRepository = {
      loadTarget: async (workflowId) => ({
        state: "available",
        workflowId,
        workflowPath: `.github/workflows/${workflowId}.yml`,
        ref: "main",
        defaultBranch: "main",
        inputs: [],
      }),
      submit: async (workflowId) => {
        dispatches++;
        if (workflowId === 2) throw new AppError("network", "Timeout after send");
      },
      listAssociationCandidates: async () => ({ runs: [], partial: false }),
    };
    const auth = new UiAuthorization();
    auth.authorize({
      repositoryId: context.id,
      target: "batch:1,2",
      ref: "main",
      inputs: { count: "2" },
    });
    const result = await executeBatchDispatch(
      repository,
      context,
      auth,
      [
        { workflowId: 1, ref: "main", inputs: {} },
        { workflowId: 2, ref: "main", inputs: {} },
      ],
      { concurrency: 2 },
    );
    assert.strictEqual(dispatches, 2);
    assert.strictEqual(result.items[0]?.state, "request_accepted");
    assert.strictEqual(result.items[1]?.state, "outcome_uncertain");
  });
});
