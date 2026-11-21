import * as vscode from "vscode";
import { resolveGitHubRemote } from "../../application/repositories/repository-service";

interface GitRemoteApi {
  readonly name: string;
  readonly fetchUrl: string;
  readonly pushUrl: string;
}

interface GitBranchApi {
  readonly name?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
}

interface RepositoryApi {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly remotes: readonly GitRemoteApi[];
    readonly HEAD?: GitBranchApi;
    readonly onDidChange?: vscode.Event<void>;
  };
}

interface GitApi {
  readonly repositories: readonly RepositoryApi[];
  readonly onDidOpenRepository?: vscode.Event<RepositoryApi>;
  readonly onDidCloseRepository?: vscode.Event<RepositoryApi>;
}

interface GitExtensionApi {
  getAPI(version: 1): GitApi;
}

export interface RepositoryChoice {
  readonly folder: vscode.WorkspaceFolder;
  readonly remoteName: string;
  readonly owner: string;
  readonly repo: string;
}

export function discoverWorkspaceRepositories(): RepositoryChoice[] {
  if (!vscode.workspace.isTrusted) return [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return [];
  const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git")?.exports;
  if (!gitExtension) return [];
  const repositories = gitExtension.getAPI(1).repositories;
  return folders.flatMap((folder) => repositories
    .filter((repository) => repository.rootUri.toString() === folder.uri.toString())
    .flatMap((repository) => resolveGitHubRemote(repository.state.remotes).map((resolved) => ({
      folder,
      remoteName: resolved.remote.name,
      owner: resolved.owner,
      repo: resolved.repo,
    }))));
}

/**
 * The remote branch name matching the branch checked out in this workspace folder: its upstream on
 * `remoteName` when tracked there, otherwise the local branch name. Undefined when detached or unknown.
 */
export function currentWorkspaceBranch(workspaceFolderUri: string, remoteName: string): string | undefined {
  try {
    const gitExtension = vscode.extensions?.getExtension<GitExtensionApi>("vscode.git");
    if (!gitExtension?.isActive) return undefined;
    const repository = gitExtension.exports.getAPI(1).repositories
      .find((candidate) => candidate.rootUri.toString() === workspaceFolderUri);
    const head = repository?.state.HEAD;
    if (!head?.name) return undefined;
    if (head.upstream && head.upstream.remote === remoteName && head.upstream.name) return head.upstream.name;
    return head.name;
  } catch {
    return undefined;
  }
}

export async function chooseRepository(): Promise<RepositoryChoice | undefined> {
  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      "ActionDeck requires a trusted workspace to inspect repository workflow files.",
      "Manage Workspace Trust",
    );
    if (choice) await vscode.commands.executeCommand("workbench.action.manageTrust");
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage("Open a workspace folder that contains a GitHub repository.");
    return undefined;
  }
  const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git")?.exports;
  if (!gitExtension) {
    void vscode.window.showErrorMessage("ActionDeck could not access the built-in Git extension.");
    return undefined;
  }
  const repositories = gitExtension.getAPI(1).repositories;
  const choices = folders.flatMap((folder) => repositories
    .filter((repository) => repository.rootUri.toString() === folder.uri.toString())
    .flatMap((repository) => resolveGitHubRemote(repository.state.remotes).map((resolved) => ({
      folder,
      remoteName: resolved.remote.name,
      owner: resolved.owner,
      repo: resolved.repo,
    }))));
  if (choices.length === 0) {
    void vscode.window.showInformationMessage("No GitHub.com remote was found in the open workspace.");
    return undefined;
  }
  const quickPickItems = choices.map((choice, index) => ({
    label: `${choice.owner}/${choice.repo}`,
    description: `${choice.folder.name} · ${choice.remoteName}`,
    choiceIndex: index,
  }));
  const selected = await vscode.window.showQuickPick(quickPickItems, {
    title: "Select the repository ActionDeck should use",
    placeHolder: "Choose a workspace folder and GitHub remote",
    canPickMany: false,
  });
  if (!selected) return undefined;
  const choice = choices[selected.choiceIndex];
  if (!choice) throw new Error("Selected repository is no longer available.");
  return choice;
}

/**
 * Fires when the set of workspace GitHub repositories may have changed: folders added or removed,
 * Git repositories opened or closed (the Git extension discovers them after activation), or remotes edited.
 */
export function onDidChangeWorkspaceRepositories(listener: () => void): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const watchRepository = (repository: RepositoryApi) => {
    if (repository.state.onDidChange) disposables.push(repository.state.onDidChange(listener));
  };
  if (typeof vscode.workspace.onDidChangeWorkspaceFolders === "function") {
    disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(listener));
  }
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === "function") {
    disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(listener));
  }
  const attach = (exports: GitExtensionApi | undefined) => {
    if (!exports) return;
    const api = exports.getAPI(1);
    api.repositories.forEach(watchRepository);
    if (api.onDidOpenRepository) {
      disposables.push(api.onDidOpenRepository((repository) => {
        watchRepository(repository);
        listener();
      }));
    }
    if (api.onDidCloseRepository) disposables.push(api.onDidCloseRepository(listener));
    listener();
  };
  const gitExtension = vscode.extensions?.getExtension<GitExtensionApi>("vscode.git");
  if (gitExtension?.isActive) attach(gitExtension.exports);
  else if (gitExtension) void Promise.resolve(gitExtension.activate()).then(attach, () => undefined);
  return new vscode.Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
}
