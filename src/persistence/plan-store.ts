import type { ReleasePlan, ReleasePlanStep } from "../domain/models/release-plan";
import { collectSensitiveKeys } from "../domain/services/plan-transitions";
import type { StateStore } from "./workspace-state";

const PLAN_STORAGE_PREFIX = "actiondeck.plans.v1:";

export class PlanStore {
  constructor(private readonly memento: StateStore) {}

  list(repositoryId: string): ReleasePlan[] {
    const raw = this.memento.get<ReleasePlan[]>(this.storageKey(repositoryId));
    return Array.isArray(raw) ? raw : [];
  }

  get(repositoryId: string, planId: string): ReleasePlan | undefined {
    return this.list(repositoryId).find((plan) => plan.id === planId);
  }

  async save(plan: ReleasePlan): Promise<ReleasePlan> {
    const sanitized: ReleasePlan = {
      ...plan,
      steps: plan.steps.map(sanitizeStepForPersistence),
    };
    const existing = this.list(plan.repositoryId).filter((item) => item.id !== plan.id);
    await this.memento.update(this.storageKey(plan.repositoryId), [...existing, sanitized]);
    return sanitized;
  }

  async remove(repositoryId: string, planId: string): Promise<void> {
    const remaining = this.list(repositoryId).filter((item) => item.id !== planId);
    await this.memento.update(this.storageKey(repositoryId), remaining);
  }

  private storageKey(repositoryId: string): string {
    return `${PLAN_STORAGE_PREFIX}${repositoryId}`;
  }
}

function sanitizeStepForPersistence(step: ReleasePlanStep): ReleasePlanStep {
  const sensitiveKeys = collectSensitiveKeys(step.inputs, step.sensitiveInputKeys);
  if (sensitiveKeys.length === 0) return step;

  const nextInputs: Record<string, string> = { ...step.inputs };
  const reEntryRequired = new Set<string>(step.reEntryRequiredKeys ?? []);
  for (const key of sensitiveKeys) {
    if (key in nextInputs) {
      nextInputs[key] = "";
      reEntryRequired.add(key);
    }
  }
  return {
    ...step,
    inputs: nextInputs,
    sensitiveInputKeys: sensitiveKeys,
    reEntryRequiredKeys: [...reEntryRequired],
  };
}
