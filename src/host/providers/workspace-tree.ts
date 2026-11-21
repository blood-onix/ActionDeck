import * as vscode from "vscode";
import { normalizeWorkflowPath } from "../../application/workflows/latest-run";
import { discoverLocalWorkflows } from "../../application/workflows/local-workflows";
import type {
  LauncherState,
  LauncherStateStore,
  RepositorySortOrder,
  WorkflowSortOrder,
} from "../../persistence/launcher-state-store";
import { latestRunLabel, type LatestRunSummary } from "./workflow-codelens";
import type { RepositoryChoice } from "./workspace-repositories";

export interface PinnedGroupTreeNode {
  readonly kind: "pinned-group";
  readonly count: number;
}

export interface RepositoryTreeNode {
  readonly kind: "repository";
  readonly choice: RepositoryChoice;
}

export interface WorkflowTreeNode {
  readonly kind: "workflow";
  readonly choice: RepositoryChoice;
  readonly workflowPath: string;
  readonly name: string;
  readonly uri: vscode.Uri;
  readonly dispatchable: boolean;
  readonly diagnostic?: string;
  readonly pinnedSection?: boolean;
}

export type WorkspaceTreeNode = PinnedGroupTreeNode | RepositoryTreeNode | WorkflowTreeNode;

export interface WorkspaceTreeSources {
  discoverRepositories(): RepositoryChoice[];
  latestRun(choice: RepositoryChoice, workflowPath: string): LatestRunSummary | undefined;
  launcherState?: LauncherStateStore;
}

const TREE_MIME = "application/vnd.code.tree.actiondeck.launcher";

const DEFAULT_LAUNCHER_STATE: LauncherState = {
  pinnedWorkflows: [],
  repositoryOrder: [],
  repositorySort: "name-asc",
  workflowSort: "name-asc",
};

interface DragPayload {
  readonly kind: "repository" | "pinned-workflow";
  readonly repositoryId: string;
  readonly workflowPath?: string;
}

/** Sidebar tree: pinned pipelines on top, then workspace GitHub repositories (collapsed by default) with local workflows. */
export class WorkspaceTreeProvider
  implements vscode.TreeDataProvider<WorkspaceTreeNode>, vscode.TreeDragAndDropController<WorkspaceTreeNode>
{
  private readonly changed = new vscode.EventEmitter<WorkspaceTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [TREE_MIME];
  readonly dropMimeTypes = [TREE_MIME];

  constructor(private readonly sources: WorkspaceTreeSources) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }

  private state(): LauncherState {
    return this.sources.launcherState?.load() ?? DEFAULT_LAUNCHER_STATE;
  }

  getVisibleRepositoryIds(): string[] {
    return this.sortedRepositories().map((choice) => repositoryNodeId(choice));
  }

  async listAllWorkflows(): Promise<WorkflowTreeNode[]> {
    const repositories = this.sortedRepositories();
    const sortOrder = this.state().workflowSort;
    const perRepo = await Promise.all(
      repositories.map((choice) => this.loadRepositoryWorkflows(choice, sortOrder)),
    );
    return perRepo.flat();
  }

  getTreeItem(node: WorkspaceTreeNode): vscode.TreeItem {
    if (node.kind === "pinned-group") {
      const item = new vscode.TreeItem("Pinned", vscode.TreeItemCollapsibleState.Expanded);
      item.id = "actiondeck.pinned";
      item.description = `${node.count}`;
      item.tooltip = "Pinned pipelines for quick access";
      item.iconPath = new vscode.ThemeIcon("pinned");
      item.contextValue = "actiondeck.pinnedGroup";
      return item;
    }

    if (node.kind === "repository") {
      const repositories = this.sources.discoverRepositories();
      const sameFolderRemotes = repositories.filter((item) => item.folder.uri.toString() === node.choice.folder.uri.toString());
      const item = new vscode.TreeItem(`${node.choice.owner}/${node.choice.repo}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = repositoryNodeId(node.choice);
      item.description = sameFolderRemotes.length > 1 ? `${node.choice.folder.name} · ${node.choice.remoteName}` : node.choice.folder.name;
      item.tooltip = `Open the ActionDeck deck for ${node.choice.owner}/${node.choice.repo}`;
      item.iconPath = new vscode.ThemeIcon("repo");
      item.contextValue = "actiondeck.repository";
      item.command = { command: "actiondeck.openRepositoryDeck", title: "Open Repository Deck", arguments: [node] };
      return item;
    }

    const repoId = repositoryNodeId(node.choice);
    const pinned = this.sources.launcherState?.isPinned(repoId, node.workflowPath) ?? false;
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = node.pinnedSection ? `pinned::${repoId}::${node.workflowPath}` : `${repoId}::${node.workflowPath}`;
    item.resourceUri = node.uri;
    const latest = this.sources.latestRun(node.choice, node.workflowPath);
    const runText = latest ? latestRunLabel(latest) : undefined;
    if (node.pinnedSection) {
      const repoLabel = `${node.choice.owner}/${node.choice.repo}`;
      item.description = runText ? `${repoLabel} · ${runText}` : repoLabel;
    } else if (runText) {
      item.description = runText;
    }
    item.iconPath = node.diagnostic ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")) : statusIcon(latest);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${node.name}**`,
        node.pinnedSection ? `Repository: \`${node.choice.owner}/${node.choice.repo}\`` : "",
        `\`${node.workflowPath}\``,
        runText ? `Last run: ${runText}` : "Last run: not loaded",
        node.diagnostic ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    const baseContext = node.dispatchable ? "actiondeck.workflow.dispatchable" : "actiondeck.workflow";
    item.contextValue = pinned ? `${baseContext}.pinned` : baseContext;
    item.command = { command: "actiondeck.openPipeline", title: "Open Pipeline Overview", arguments: [node] };
    return item;
  }

  async getChildren(node?: WorkspaceTreeNode): Promise<WorkspaceTreeNode[]> {
    if (!node) {
      const repositories = this.sortedRepositories();
      const pinned = await this.resolvePinnedWorkflows(repositories);
      const roots: WorkspaceTreeNode[] = [];
      if (pinned.length > 0) {
        roots.push({ kind: "pinned-group", count: pinned.length });
      }
      for (const choice of repositories) {
        roots.push({ kind: "repository", choice });
      }
      return roots;
    }
    if (node.kind === "pinned-group") {
      return this.resolvePinnedWorkflows(this.sortedRepositories());
    }
    if (node.kind !== "repository") return [];
    return this.loadRepositoryWorkflows(node.choice, this.state().workflowSort);
  }

  handleDrag(source: readonly WorkspaceTreeNode[], dataTransfer: vscode.DataTransfer): void {
    const first = source[0];
    if (!first) return;
    if (first.kind === "repository") {
      const payload: DragPayload = { kind: "repository", repositoryId: repositoryNodeId(first.choice) };
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
      return;
    }
    if (first.kind === "workflow" && first.pinnedSection) {
      const payload: DragPayload = {
        kind: "pinned-workflow",
        repositoryId: repositoryNodeId(first.choice),
        workflowPath: first.workflowPath,
      };
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
    }
  }

  async handleDrop(target: WorkspaceTreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (!target || !this.sources.launcherState) return;
    const item = dataTransfer.get(TREE_MIME);
    if (!item) return;
    let payload: DragPayload;
    try {
      const raw = await item.asString();
      payload = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }

    if (payload.kind === "repository" && target.kind === "repository") {
      const changed = await this.sources.launcherState.reorderRepository(
        payload.repositoryId,
        repositoryNodeId(target.choice),
        this.getVisibleRepositoryIds(),
      );
      if (changed) this.refresh();
      return;
    }

    if (
      payload.kind === "pinned-workflow" &&
      payload.workflowPath &&
      target.kind === "workflow" &&
      target.pinnedSection
    ) {
      const changed = await this.sources.launcherState.reorderPinnedWorkflow(
        { repositoryId: payload.repositoryId, workflowPath: payload.workflowPath },
        { repositoryId: repositoryNodeId(target.choice), workflowPath: target.workflowPath },
      );
      if (changed) this.refresh();
    }
  }

  private sortedRepositories(): RepositoryChoice[] {
    const repositories = [...this.sources.discoverRepositories()];
    const { repositorySort, repositoryOrder } = this.state();
    return sortRepositories(repositories, repositorySort, repositoryOrder);
  }

  private async resolvePinnedWorkflows(repositories: readonly RepositoryChoice[]): Promise<WorkflowTreeNode[]> {
    const pinnedRefs = this.state().pinnedWorkflows;
    if (pinnedRefs.length === 0) return [];

    const repoById = new Map(repositories.map((choice) => [repositoryNodeId(choice), choice]));
    const neededRepoIds = new Set(pinnedRefs.map((ref) => ref.repositoryId).filter((id) => repoById.has(id)));
    const workflowsByRepo = new Map<string, Map<string, WorkflowTreeNode>>();

    await Promise.all(
      [...neededRepoIds].map(async (repoId) => {
        const choice = repoById.get(repoId);
        if (!choice) return;
        const nodes = await this.loadRepositoryWorkflows(choice, "name-asc");
        workflowsByRepo.set(
          repoId,
          new Map(nodes.map((wf) => [normalizeWorkflowPath(wf.workflowPath), wf])),
        );
      }),
    );

    const resolved: WorkflowTreeNode[] = [];
    for (const ref of pinnedRefs) {
      const match = workflowsByRepo.get(ref.repositoryId)?.get(normalizeWorkflowPath(ref.workflowPath));
      if (match) {
        resolved.push({ ...match, pinnedSection: true });
      }
    }
    return resolved;
  }

  private async loadRepositoryWorkflows(
    choice: RepositoryChoice,
    sortOrder: WorkflowSortOrder,
  ): Promise<WorkflowTreeNode[]> {
    let workflows: Awaited<ReturnType<typeof discoverLocalWorkflows>>;
    try {
      workflows = await discoverLocalWorkflows(choice.folder);
    } catch {
      return [];
    }
    const nodes: WorkflowTreeNode[] = workflows
      .filter((workflow) => !workflow.reusable)
      .map((workflow) => ({
        kind: "workflow" as const,
        choice,
        workflowPath: workflow.path,
        name: workflow.name,
        uri: vscode.Uri.joinPath(choice.folder.uri, ...workflow.path.split("/")),
        dispatchable: workflow.dispatchable,
        ...(workflow.diagnostic ? { diagnostic: workflow.diagnostic } : {}),
      }));
    return sortWorkflows(nodes, sortOrder, (node) => this.sources.latestRun(node.choice, node.workflowPath));
  }
}

export function isWorkspaceTreeNode(value: unknown): value is WorkspaceTreeNode {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "pinned-group") return true;
  return (kind === "repository" || kind === "workflow") && typeof (value as { choice?: unknown }).choice === "object";
}

export function repositoryNodeId(choice: RepositoryChoice): string {
  return `${choice.folder.uri.toString()}::${choice.remoteName}::${choice.owner}/${choice.repo}`;
}

function repoLabel(choice: RepositoryChoice): string {
  return `${choice.owner}/${choice.repo}`;
}

function sortRepositories(
  repositories: RepositoryChoice[],
  sortOrder: RepositorySortOrder,
  manualOrder: readonly string[],
): RepositoryChoice[] {
  if (sortOrder === "name-desc") {
    return repositories.sort((left, right) => repoLabel(right).localeCompare(repoLabel(left)));
  }
  if (sortOrder === "manual") {
    const indexById = new Map(manualOrder.map((id, index) => [id, index]));
    return repositories.sort((left, right) => {
      const leftIndex = indexById.get(repositoryNodeId(left));
      const rightIndex = indexById.get(repositoryNodeId(right));
      if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
      if (leftIndex !== undefined) return -1;
      if (rightIndex !== undefined) return 1;
      return repoLabel(left).localeCompare(repoLabel(right));
    });
  }
  return repositories.sort((left, right) => repoLabel(left).localeCompare(repoLabel(right)));
}

function sortWorkflows(
  workflows: WorkflowTreeNode[],
  sortOrder: WorkflowSortOrder,
  latestRun: (node: WorkflowTreeNode) => LatestRunSummary | undefined,
): WorkflowTreeNode[] {
  if (sortOrder === "name-desc") {
    return workflows.sort((left, right) => right.name.localeCompare(left.name));
  }
  if (sortOrder === "recent") {
    return workflows.sort((left, right) => {
      const leftTime = runTimestamp(latestRun(left));
      const rightTime = runTimestamp(latestRun(right));
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.name.localeCompare(right.name);
    });
  }
  if (sortOrder === "status") {
    return workflows.sort((left, right) => {
      const leftRank = statusRank(latestRun(left));
      const rightRank = statusRank(latestRun(right));
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.name.localeCompare(right.name);
    });
  }
  return workflows.sort((left, right) => left.name.localeCompare(right.name));
}

function runTimestamp(latest: LatestRunSummary | undefined): number {
  if (!latest?.updatedAt) return -1;
  const parsed = Date.parse(latest.updatedAt);
  return Number.isFinite(parsed) ? parsed : -1;
}

function statusRank(latest: LatestRunSummary | undefined): number {
  if (!latest) return 4;
  if (latest.conclusion === "failure" || latest.conclusion === "timed_out" || latest.conclusion === "startup_failure") {
    return 0;
  }
  if (!latest.conclusion && ["in_progress", "queued", "waiting", "pending", "requested"].includes(latest.status)) {
    return 1;
  }
  if (latest.conclusion === "success") return 2;
  return 3;
}

function statusIcon(latest: LatestRunSummary | undefined): vscode.ThemeIcon {
  if (!latest) return new vscode.ThemeIcon("circle-outline");
  if (latest.conclusion === "success") return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  if (latest.conclusion === "failure" || latest.conclusion === "timed_out" || latest.conclusion === "startup_failure") {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  }
  if (latest.conclusion === "cancelled" || latest.conclusion === "skipped") return new vscode.ThemeIcon("circle-slash");
  if (!latest.conclusion && ["in_progress", "queued", "waiting", "pending", "requested"].includes(latest.status)) {
    return new vscode.ThemeIcon("sync~spin");
  }
  return new vscode.ThemeIcon("circle-filled");
}
