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

/**
 * The built-in Git API when it is already usable. Reading `exports` of an extension that has not activated
 * throws "Extension 'vscode.git' is not known or not activated", and `getAPI` throws when Git is disabled.
 */
function activeGitApi(): GitApi | undefined {
  try {
    const extension = vscode.extensions?.getExtension<GitExtensionApi>("vscode.git");
    if (!extension?.isActive) return undefined;
    return extension.exports?.getAPI(1);
  } catch {
    return undefined;
  }
}

/** Activates the built-in Git extension when needed; undefined when it is missing or disabled. */
async function loadGitApi(): Promise<GitApi | undefined> {
  try {
    const extension = vscode.extensions?.getExtension<GitExtensionApi>("vscode.git");
    if (!extension) return undefined;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports?.getAPI(1);
  } catch {
    return undefined;
  }
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
  // Before Git activates this is empty; onDidChangeWorkspaceRepositories fires once it is ready.
  const repositories = activeGitApi()?.repositories;
  if (!repositories) return [];
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
    const repository = activeGitApi()?.repositories
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
  const git = await loadGitApi();
  if (!git) {
    void vscode.window.showErrorMessage(
      "ActionDeck could not access the built-in Git extension. Make sure it is enabled and the git.enabled setting is on.",
    );
    return undefined;
  }
  const repositories = git.repositories;
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
  const attach = (api: GitApi | undefined) => {
    if (!api) return;
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
  void loadGitApi().then(attach, () => undefined);
  return new vscode.Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
}
