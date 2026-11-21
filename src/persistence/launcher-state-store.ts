import { normalizeWorkflowPath } from "../application/workflows/latest-run";
import type { StateStore } from "./workspace-state";

export type RepositorySortOrder = "name-asc" | "name-desc" | "manual";
export type WorkflowSortOrder = "name-asc" | "name-desc" | "recent" | "status";

export interface PinnedWorkflowRef {
  readonly repositoryId: string;
  readonly workflowPath: string;
}

export interface LauncherState {
  readonly pinnedWorkflows: readonly PinnedWorkflowRef[];
  readonly repositoryOrder: readonly string[];
  readonly repositorySort: RepositorySortOrder;
  readonly workflowSort: WorkflowSortOrder;
}

const LAUNCHER_STATE_KEY = "actiondeck.launcher.v1";

const VALID_REPO_SORTS = new Set<RepositorySortOrder>(["name-asc", "name-desc", "manual"]);
const VALID_WORKFLOW_SORTS = new Set<WorkflowSortOrder>(["name-asc", "name-desc", "recent", "status"]);

const DEFAULT_STATE: LauncherState = {
  pinnedWorkflows: [],
  repositoryOrder: [],
  repositorySort: "name-asc",
  workflowSort: "name-asc",
};

/** Workspace-scoped persistence for sidebar pins, repository order, and sort preferences. */
export class LauncherStateStore {
  constructor(private readonly store: StateStore) {}

  load(): LauncherState {
    const raw = this.store.get<Partial<LauncherState>>(LAUNCHER_STATE_KEY);
    if (!raw || typeof raw !== "object") return DEFAULT_STATE;

    const pinnedWorkflows: PinnedWorkflowRef[] = [];
    const seenPins = new Set<string>();
    if (Array.isArray(raw.pinnedWorkflows)) {
      for (const entry of raw.pinnedWorkflows) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.repositoryId === "string" &&
          entry.repositoryId.length > 0 &&
          typeof entry.workflowPath === "string" &&
          entry.workflowPath.length > 0
        ) {
          const workflowPath = normalizeWorkflowPath(entry.workflowPath);
          const key = pinKey(entry.repositoryId, workflowPath);
          if (!seenPins.has(key)) {
            seenPins.add(key);
            pinnedWorkflows.push({ repositoryId: entry.repositoryId, workflowPath });
          }
        }
      }
    }

    const repositoryOrder: string[] = [];
    const seenRepos = new Set<string>();
    if (Array.isArray(raw.repositoryOrder)) {
      for (const id of raw.repositoryOrder) {
        if (typeof id === "string" && id.length > 0 && !seenRepos.has(id)) {
          seenRepos.add(id);
          repositoryOrder.push(id);
        }
      }
    }

    const repositorySort = VALID_REPO_SORTS.has(raw.repositorySort as RepositorySortOrder)
      ? (raw.repositorySort as RepositorySortOrder)
      : "name-asc";
    const workflowSort = VALID_WORKFLOW_SORTS.has(raw.workflowSort as WorkflowSortOrder)
      ? (raw.workflowSort as WorkflowSortOrder)
      : "name-asc";

    return { pinnedWorkflows, repositoryOrder, repositorySort, workflowSort };
  }

  isPinned(repositoryId: string, workflowPath: string): boolean {
    const normalized = normalizeWorkflowPath(workflowPath);
    return this.load().pinnedWorkflows.some(
      (entry) => entry.repositoryId === repositoryId && entry.workflowPath === normalized,
    );
  }

  async pinWorkflow(repositoryId: string, workflowPath: string): Promise<boolean> {
    const normalized = normalizeWorkflowPath(workflowPath);
    const state = this.load();
    if (state.pinnedWorkflows.some((entry) => entry.repositoryId === repositoryId && entry.workflowPath === normalized)) {
      return false;
    }
    await this.save({
      ...state,
      pinnedWorkflows: [...state.pinnedWorkflows, { repositoryId, workflowPath: normalized }],
    });
    return true;
  }

  async unpinWorkflow(repositoryId: string, workflowPath: string): Promise<boolean> {
    const normalized = normalizeWorkflowPath(workflowPath);
    const state = this.load();
    const next = state.pinnedWorkflows.filter(
      (entry) => !(entry.repositoryId === repositoryId && entry.workflowPath === normalized),
    );
    if (next.length === state.pinnedWorkflows.length) return false;
    await this.save({ ...state, pinnedWorkflows: next });
    return true;
  }

  async reorderPinnedWorkflow(source: PinnedWorkflowRef, target: PinnedWorkflowRef): Promise<boolean> {
    const sourceKey = pinKey(source.repositoryId, normalizeWorkflowPath(source.workflowPath));
    const targetKey = pinKey(target.repositoryId, normalizeWorkflowPath(target.workflowPath));
    if (sourceKey === targetKey) return false;

    const state = this.load();
    const list = [...state.pinnedWorkflows];
    const fromIndex = list.findIndex((item) => pinKey(item.repositoryId, item.workflowPath) === sourceKey);
    const toIndex = list.findIndex((item) => pinKey(item.repositoryId, item.workflowPath) === targetKey);
    if (fromIndex < 0 || toIndex < 0) return false;

    const [moved] = list.splice(fromIndex, 1);
    if (!moved) return false;
    list.splice(toIndex, 0, moved);
    await this.save({ ...state, pinnedWorkflows: list });
    return true;
  }

  async moveRepository(
    repositoryId: string,
    direction: "up" | "down",
    visibleRepositoryIds: readonly string[],
  ): Promise<boolean> {
    const order = materializeOrder(visibleRepositoryIds, this.load().repositoryOrder);
    const index = order.indexOf(repositoryId);
    if (index < 0) return false;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= order.length) return false;

    const [moved] = order.splice(index, 1);
    if (!moved) return false;
    order.splice(targetIndex, 0, moved);
    await this.save({
      ...this.load(),
      repositoryOrder: order,
      repositorySort: "manual",
    });
    return true;
  }

  async reorderRepository(
    sourceId: string,
    targetId: string,
    visibleRepositoryIds: readonly string[],
  ): Promise<boolean> {
    if (sourceId === targetId) return false;
    const order = materializeOrder(visibleRepositoryIds, this.load().repositoryOrder);
    const fromIndex = order.indexOf(sourceId);
    const toIndex = order.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return false;

    const [moved] = order.splice(fromIndex, 1);
    if (!moved) return false;
    order.splice(toIndex, 0, moved);
    await this.save({
      ...this.load(),
      repositoryOrder: order,
      repositorySort: "manual",
    });
    return true;
  }

  async setRepositorySort(repositorySort: RepositorySortOrder): Promise<void> {
    const state = this.load();
    if (state.repositorySort === repositorySort) return;
    await this.save({ ...state, repositorySort });
  }

  async setWorkflowSort(workflowSort: WorkflowSortOrder): Promise<void> {
    const state = this.load();
    if (state.workflowSort === workflowSort) return;
    await this.save({ ...state, workflowSort });
  }

  private async save(state: LauncherState): Promise<void> {
    await this.store.update(LAUNCHER_STATE_KEY, state);
  }
}

function pinKey(repositoryId: string, workflowPath: string): string {
  return `${repositoryId}::${workflowPath}`;
}

/** Keeps the current visible order up front and preserves any previously saved ids not currently visible. */
function materializeOrder(visibleIds: readonly string[], savedOrder: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of visibleIds) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of savedOrder) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
