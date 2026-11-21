import type { AutoApprovalRule } from "../domain/models/approval";
import type { StateStore } from "./workspace-state";

const RULE_PREFIX = "actiondeck.approvalRules.v1:";

export class ApprovalRuleStore {
  constructor(private readonly store: StateStore) {}

  list(repositoryId: string): AutoApprovalRule[] {
    const raw = this.store.get<AutoApprovalRule[]>(`${RULE_PREFIX}${repositoryId}`);
    return Array.isArray(raw) ? raw : [];
  }

  async save(rule: AutoApprovalRule): Promise<AutoApprovalRule> {
    const existing = this.list(rule.repositoryId).filter((r) => r.id !== rule.id);
    await this.store.update(`${RULE_PREFIX}${rule.repositoryId}`, [...existing, rule]);
    return rule;
  }
}
