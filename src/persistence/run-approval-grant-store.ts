import type { RunApprovalGrant } from "../domain/models/approval";
import type { StateStore } from "./workspace-state";

const GRANT_PREFIX = "actiondeck.runApprovalGrants.v1:";

export class RunApprovalGrantStore {
  constructor(private readonly store: StateStore) {}

  list(repositoryId: string): RunApprovalGrant[] {
    const raw = this.store.get<RunApprovalGrant[]>(`${GRANT_PREFIX}${repositoryId}`);
    return Array.isArray(raw) ? raw : [];
  }

  async replace(repositoryId: string, grants: readonly RunApprovalGrant[]): Promise<void> {
    await this.store.update(`${GRANT_PREFIX}${repositoryId}`, [...grants]);
  }
}
