import * as assert from "node:assert";
import { AutoApprovalService } from "../../src/application/approvals/auto-approval-service";
import { ApprovalRuleStore } from "../../src/persistence/approval-rule-store";

class MemoryStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

suite("Action Center & Auto-Approval integration", () => {
  test("halts enabled auto-approval rules immediately on identity change", async () => {
    const context = {
      id: "acme/demo|origin|file:///repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
      authenticatedUserId: "42",
    };
    const service = new AutoApprovalService(new ApprovalRuleStore(new MemoryStore()));
    await service.saveRule({
      id: "rule-int-1",
      repositoryId: context.id,
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      authenticatedUserId: "42",
      enabled: true,
      createdAt: Date.now(),
    });

    assert.ok(service.findMatchingRule(context, {
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      originalActorId: "42",
      eligible: true,
    }));

    await service.haltAllOnIdentityChange(context.id);
    assert.strictEqual(service.findMatchingRule(context, {
      workflowId: 7,
      environmentName: "staging",
      ref: "main",
      originalActorId: "42",
      eligible: true,
    }), undefined);
  });
});
