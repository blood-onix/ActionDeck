import type { AutoApprovalRule } from "../../domain/models/approval";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import { ApprovalRuleStore } from "../../persistence/approval-rule-store";

export class AutoApprovalService {
  constructor(private readonly store: ApprovalRuleStore) {}

  listRules(repositoryId: string): AutoApprovalRule[] {
    return this.store.list(repositoryId);
  }

  async saveRule(rule: AutoApprovalRule): Promise<AutoApprovalRule> {
    return this.store.save(rule);
  }

  async setRuleEnabled(repositoryId: string, ruleId: string, enabled: boolean): Promise<AutoApprovalRule> {
    const existing = this.store.list(repositoryId).find((r) => r.id === ruleId);
    if (!existing) throw new AppError("not_found", "Auto-approval rule was not found.");
    return this.store.save({ ...existing, enabled });
  }

  async haltAllOnIdentityChange(repositoryId: string): Promise<void> {
    for (const rule of this.store.list(repositoryId)) {
      if (rule.enabled) {
        await this.store.save({ ...rule, enabled: false });
      }
    }
  }

  findMatchingRule(
    context: RepositoryContext,
    candidate: {
      readonly workflowId: number;
      readonly environmentName: string;
      readonly ref: string;
      readonly originalActorId: string;
      readonly eligible: boolean;
    },
  ): AutoApprovalRule | undefined {
    if (!candidate.eligible) return undefined;
    if (!context.authenticatedUserId || candidate.originalActorId !== context.authenticatedUserId) {
      return undefined;
    }
    return this.store.list(context.id).find((rule) =>
      rule.enabled &&
      rule.repositoryId === context.id &&
      rule.workflowId === candidate.workflowId &&
      rule.environmentName === candidate.environmentName &&
      rule.ref === candidate.ref &&
      rule.authenticatedUserId === context.authenticatedUserId,
    );
  }
}
