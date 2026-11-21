import type { RepositoryContext } from "../../domain/models/repository";
import { repositoryContextId } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";

export interface GitRemote {
  readonly name: string;
  readonly fetchUrl: string;
  readonly pushUrl: string;
}

export function resolveGitHubRemote(
  remotes: readonly GitRemote[],
): Array<{ remote: GitRemote; owner: string; repo: string }> {
  const resolved: Array<{ remote: GitRemote; owner: string; repo: string }> = [];
  for (const remote of remotes) {
    const identity = parseGitHubUrl(remote.fetchUrl) ?? parseGitHubUrl(remote.pushUrl);
    if (identity) resolved.push({ remote, ...identity });
  }
  return resolved;
}

export function createRepositoryContext(
  folderUri: string,
  remoteName: string,
  owner: string,
  repo: string,
  authenticatedUserId?: string,
): RepositoryContext {
  if ([folderUri, remoteName, owner, repo].some((value) => !value.trim())) {
    throw new AppError("invalid_input", "A workspace folder, Git remote, owner, and repository must be selected.");
  }
  return {
    id: repositoryContextId(owner, repo, remoteName, folderUri),
    owner,
    repo,
    remoteName,
    workspaceFolderUri: folderUri,
    ...(authenticatedUserId ? { authenticatedUserId } : {}),
  };
}

function parseGitHubUrl(value: string): { owner: string; repo: string } | undefined {
  let pathname: string;
  try {
    if (/^[^/@\s]+@github\.com:/i.test(value)) {
      pathname = value.slice(value.indexOf(":") + 1);
    } else {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== "github.com") return undefined;
      pathname = url.pathname;
    }
  } catch {
    return undefined;
  }
  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], repo: match[2] };
}
