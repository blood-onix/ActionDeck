import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDirectory: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("vscode", () => {
  class ThemeIcon {
    constructor(readonly id: string, readonly color?: unknown) {}
  }
  class ThemeColor {
    constructor(readonly id: string) {}
  }
  class TreeItem {
    id?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;
    resourceUri?: unknown;
    constructor(readonly label: string, readonly collapsibleState: number) {}
  }
  class MarkdownString {
    constructor(readonly value: string) {}
  }
  class DataTransferItem {
    constructor(private readonly value: string) {}
    async asString(): Promise<string> {
      return this.value;
    }
  }
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire = vi.fn();
    dispose() {}
  }
  const joinPath = (base: { path: string }, ...segments: string[]) => {
    const path = [base.path, ...segments].join("/");
    return { path, toString: () => `file://${path}` };
  };
  return {
    ThemeIcon,
    ThemeColor,
    TreeItem,
    MarkdownString,
    DataTransferItem,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileType: { File: 1, Directory: 2 },
    FileSystemError: class extends Error {},
    Uri: { joinPath },
    workspace: { fs: { readDirectory: mocks.readDirectory, readFile: mocks.readFile } },
  };
});

import { LauncherStateStore } from "../../src/persistence/launcher-state-store";
import type { StateStore } from "../../src/persistence/workspace-state";
import { repositoryNodeId, WorkspaceTreeProvider, type WorkspaceTreeNode } from "../../src/host/providers/workspace-tree";

class MemoryState implements StateStore {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeDataTransfer {
  private readonly items = new Map<string, { asString(): Promise<string> }>();
  set(mime: string, item: { asString(): Promise<string> }): void {
    this.items.set(mime, item);
  }
  get(mime: string) {
    return this.items.get(mime);
  }
}

const folder = { uri: { path: "/repo", toString: () => "file:///repo" }, name: "repo", index: 0 };
const choice = { folder, remoteName: "origin", owner: "acme", repo: "demo" } as never;
const folderB = { uri: { path: "/repo-b", toString: () => "file:///repo-b" }, name: "repo-b", index: 1 };
const choiceB = { folder: folderB, remoteName: "origin", owner: "acme", repo: "alpha" } as never;
const folderC = { uri: { path: "/repo-c", toString: () => "file:///repo-c" }, name: "repo-c", index: 2 };
const choiceC = { folder: folderC, remoteName: "origin", owner: "acme", repo: "zeta" } as never;

describe("workspace tree", () => {
  it("lists repositories collapsed by default, then their workflows sorted by name with latest-run status", async () => {
    mocks.readDirectory.mockResolvedValue([["release.yml", 1], ["build.yaml", 1], ["notes.md", 1], ["nested", 2]]);
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("name: x\non:\n  workflow_dispatch:\njobs: {}\n"));
    const provider = new WorkspaceTreeProvider({
      discoverRepositories: () => [choice],
      latestRun: (_choice, path) => path.endsWith("release.yml")
        ? { status: "completed", conclusion: "failure", updatedAt: new Date().toISOString() }
        : undefined,
    });

    const roots = await provider.getChildren();
    expect(roots).toHaveLength(1);
    const repoItem = provider.getTreeItem(roots[0] as WorkspaceTreeNode);
    expect(repoItem.label).toBe("acme/demo");
    expect(repoItem.collapsibleState).toBe(1); // Collapsed
    expect(repoItem.contextValue).toBe("actiondeck.repository");
    expect(repoItem.command).toMatchObject({ command: "actiondeck.openRepositoryDeck" });

    const workflows = await provider.getChildren(roots[0]);
    expect(workflows.map((node) => node.kind === "workflow" && node.workflowPath)).toEqual([
      ".github/workflows/build.yaml",
      ".github/workflows/release.yml",
    ]);
    const release = provider.getTreeItem(workflows[1] as WorkspaceTreeNode);
    expect(release.command).toMatchObject({ command: "actiondeck.openPipeline", arguments: [workflows[1]] });
    expect(release.description).toMatch(/^Failure/);
    expect((release.iconPath as { id: string }).id).toBe("error");
    expect(release.contextValue).toBe("actiondeck.workflow.dispatchable");
    const build = provider.getTreeItem(workflows[0] as WorkspaceTreeNode);
    expect(build.description).toBeUndefined();
    expect((build.iconPath as { id: string }).id).toBe("circle-outline");
  });

  it("shows no workflows when the repository has no workflows folder", async () => {
    mocks.readDirectory.mockRejectedValue(new Error("missing"));
    const provider = new WorkspaceTreeProvider({ discoverRepositories: () => [choice], latestRun: () => undefined });
    const [root] = await provider.getChildren();
    await expect(provider.getChildren(root)).resolves.toEqual([]);
  });

  it("surfaces pinned pipelines in an expanded Pinned section on top with repo context and distinct ids", async () => {
    mocks.readDirectory.mockResolvedValue([["release.yml", 1], ["build.yaml", 1]]);
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("on:\n  workflow_dispatch:\njobs: {}\n"));
    const launcherState = new LauncherStateStore(new MemoryState());
    await launcherState.pinWorkflow(repositoryNodeId(choice), ".github/workflows/release.yml");
    await launcherState.pinWorkflow(repositoryNodeId(choice), ".github/workflows/deleted.yml");

    const provider = new WorkspaceTreeProvider({
      discoverRepositories: () => [choice],
      latestRun: (_choice, path) => path.endsWith("release.yml")
        ? { status: "completed", conclusion: "success", updatedAt: new Date().toISOString() }
        : undefined,
      launcherState,
    });

    const roots = await provider.getChildren();
    expect(roots.map((n) => n.kind)).toEqual(["pinned-group", "repository"]);
    const pinnedGroupItem = provider.getTreeItem(roots[0]!);
    expect(pinnedGroupItem.label).toBe("Pinned");
    expect(pinnedGroupItem.collapsibleState).toBe(2); // Expanded
    expect(pinnedGroupItem.description).toBe("1");

    const pinnedChildren = await provider.getChildren(roots[0]);
    expect(pinnedChildren).toHaveLength(1);
    const pinnedItem = provider.getTreeItem(pinnedChildren[0]!);
    expect(pinnedItem.id).toMatch(/^pinned::/);
    expect(pinnedItem.description).toMatch(/^acme\/demo · Success/);
    expect(pinnedItem.contextValue).toBe("actiondeck.workflow.dispatchable.pinned");
  });

  it("sorts repositories by name-asc, name-desc, and manual order with drag-and-drop", async () => {
    mocks.readDirectory.mockResolvedValue([]);
    const launcherState = new LauncherStateStore(new MemoryState());
    const provider = new WorkspaceTreeProvider({
      discoverRepositories: () => [choice, choiceC, choiceB],
      latestRun: () => undefined,
      launcherState,
    });

    expect((await provider.getChildren()).map((n) => n.kind === "repository" && n.choice.repo)).toEqual([
      "alpha",
      "demo",
      "zeta",
    ]);

    await launcherState.setRepositorySort("name-desc");
    expect((await provider.getChildren()).map((n) => n.kind === "repository" && n.choice.repo)).toEqual([
      "zeta",
      "demo",
      "alpha",
    ]);

    // Drag alpha onto zeta -> switches to manual order with alpha first
    const roots = await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag([roots[2]!], dt as never);
    await provider.handleDrop(roots[0]!, dt as never);

    expect(launcherState.load().repositorySort).toBe("manual");
    expect((await provider.getChildren()).map((n) => n.kind === "repository" && n.choice.repo)).toEqual([
      "alpha",
      "zeta",
      "demo",
    ]);
  });

  it("sorts workflows by recent run and by status priority, and lists all workflows globally", async () => {
    mocks.readDirectory.mockResolvedValue([["alpha.yml", 1], ["beta.yml", 1], ["gamma.yml", 1]]);
    mocks.readFile.mockResolvedValue(new TextEncoder().encode("on: push\njobs: {}\n"));
    const launcherState = new LauncherStateStore(new MemoryState());
    const runs: Record<string, { status: string; conclusion: string | null; updatedAt: string }> = {
      ".github/workflows/alpha.yml": { status: "completed", conclusion: "success", updatedAt: "2026-01-01T10:00:00Z" },
      ".github/workflows/beta.yml": { status: "completed", conclusion: "failure", updatedAt: "2026-01-01T08:00:00Z" },
      ".github/workflows/gamma.yml": { status: "in_progress", conclusion: null, updatedAt: "2026-01-01T12:00:00Z" },
    };

    const provider = new WorkspaceTreeProvider({
      discoverRepositories: () => [choice],
      latestRun: (_choice, path) => runs[path],
      launcherState,
    });

    await launcherState.setWorkflowSort("recent");
    const [repo] = await provider.getChildren();
    expect((await provider.getChildren(repo)).map((n) => n.kind === "workflow" && n.workflowPath)).toEqual([
      ".github/workflows/gamma.yml",
      ".github/workflows/alpha.yml",
      ".github/workflows/beta.yml",
    ]);

    await launcherState.setWorkflowSort("status");
    expect((await provider.getChildren(repo)).map((n) => n.kind === "workflow" && n.workflowPath)).toEqual([
      ".github/workflows/beta.yml",
      ".github/workflows/gamma.yml",
      ".github/workflows/alpha.yml",
    ]);

    const all = await provider.listAllWorkflows();
    expect(all).toHaveLength(3);
  });
});
