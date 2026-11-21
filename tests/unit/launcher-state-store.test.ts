import { describe, expect, it } from "vitest";
import { LauncherStateStore } from "../../src/persistence/launcher-state-store";
import type { StateStore } from "../../src/persistence/workspace-state";

class MemoryState implements StateStore {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe("launcher state store", () => {
  it("returns sensible defaults when nothing is persisted or data is malformed", () => {
    const state = new MemoryState();
    const store = new LauncherStateStore(state);
    expect(store.load()).toEqual({
      pinnedWorkflows: [],
      repositoryOrder: [],
      repositorySort: "name-asc",
      workflowSort: "name-asc",
    });

    state.values.set("actiondeck.launcher.v1", {
      pinnedWorkflows: [{ repositoryId: "", workflowPath: "a.yml" }, "bad", { repositoryId: "r1", workflowPath: "/.github/workflows/ci.yml" }],
      repositoryOrder: ["r1", "", 42, "r1"],
      repositorySort: "invalid",
      workflowSort: "invalid",
    });
    expect(store.load()).toEqual({
      pinnedWorkflows: [{ repositoryId: "r1", workflowPath: ".github/workflows/ci.yml" }],
      repositoryOrder: ["r1"],
      repositorySort: "name-asc",
      workflowSort: "name-asc",
    });
  });

  it("pins, deduplicates, reorders, and unpins workflows", async () => {
    const store = new LauncherStateStore(new MemoryState());

    expect(await store.pinWorkflow("r1", ".github/workflows/ci.yml")).toBe(true);
    expect(await store.pinWorkflow("r1", "/.github/workflows/ci.yml")).toBe(false);
    expect(await store.pinWorkflow("r2", ".github/workflows/deploy.yml")).toBe(true);

    expect(store.isPinned("r1", ".github/workflows/ci.yml")).toBe(true);
    expect(store.isPinned("r2", ".github/workflows/deploy.yml")).toBe(true);
    expect(store.isPinned("r1", ".github/workflows/other.yml")).toBe(false);

    expect(
      await store.reorderPinnedWorkflow(
        { repositoryId: "r2", workflowPath: ".github/workflows/deploy.yml" },
        { repositoryId: "r1", workflowPath: ".github/workflows/ci.yml" },
      ),
    ).toBe(true);
    expect(store.load().pinnedWorkflows).toEqual([
      { repositoryId: "r2", workflowPath: ".github/workflows/deploy.yml" },
      { repositoryId: "r1", workflowPath: ".github/workflows/ci.yml" },
    ]);

    expect(await store.unpinWorkflow("r1", ".github/workflows/ci.yml")).toBe(true);
    expect(await store.unpinWorkflow("r1", ".github/workflows/ci.yml")).toBe(false);
    expect(store.load().pinnedWorkflows).toEqual([
      { repositoryId: "r2", workflowPath: ".github/workflows/deploy.yml" },
    ]);
  });

  it("moves and drag-reorders repositories and switches repositorySort to manual", async () => {
    const store = new LauncherStateStore(new MemoryState());
    const visible = ["r1", "r2", "r3"];

    expect(await store.moveRepository("r1", "up", visible)).toBe(false);
    expect(await store.moveRepository("r3", "down", visible)).toBe(false);

    expect(await store.moveRepository("r2", "up", visible)).toBe(true);
    expect(store.load().repositorySort).toBe("manual");
    expect(store.load().repositoryOrder).toEqual(["r2", "r1", "r3"]);

    expect(await store.reorderRepository("r3", "r2", ["r2", "r1", "r3"])).toBe(true);
    expect(store.load().repositoryOrder).toEqual(["r3", "r2", "r1"]);
    expect(await store.reorderRepository("r3", "r3", ["r3", "r2", "r1"])).toBe(false);
  });

  it("updates repository and workflow sort orders", async () => {
    const store = new LauncherStateStore(new MemoryState());
    await store.setRepositorySort("name-desc");
    await store.setWorkflowSort("status");
    expect(store.load().repositorySort).toBe("name-desc");
    expect(store.load().workflowSort).toBe("status");
  });
});
