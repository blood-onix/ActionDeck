import type { SubscriptionMode } from "../domain/models/notifications";
import type { StateStore } from "./workspace-state";

const SUBSCRIPTION_PREFIX = "actiondeck.subscriptions.v1:";

export class SubscriptionStore {
  constructor(private readonly store: StateStore) {}

  getWorkflowMode(repositoryId: string, workflowId: number): SubscriptionMode {
    const map = this.store.get<Record<string, SubscriptionMode>>(`${SUBSCRIPTION_PREFIX}${repositoryId}`) ?? {};
    return map[String(workflowId)] ?? "my_runs_only";
  }

  listModes(repositoryId: string): Map<number, SubscriptionMode> {
    const map = this.store.get<Record<string, SubscriptionMode>>(`${SUBSCRIPTION_PREFIX}${repositoryId}`) ?? {};
    return new Map(Object.entries(map).map(([workflowId, mode]) => [Number(workflowId), mode]));
  }

  async setWorkflowMode(repositoryId: string, workflowId: number, mode: SubscriptionMode): Promise<void> {
    const map = { ...(this.store.get<Record<string, SubscriptionMode>>(`${SUBSCRIPTION_PREFIX}${repositoryId}`) ?? {}) };
    map[String(workflowId)] = mode;
    await this.store.update(`${SUBSCRIPTION_PREFIX}${repositoryId}`, map);
  }
}
