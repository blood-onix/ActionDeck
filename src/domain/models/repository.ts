/**
 * owner/repo and selected remote must resolve explicitly; no first-folder/first-remote fallback.
 * Tokens are never part of the entity or persisted representation.
 * Plans remain bound to the context in which they were created.
 */
export interface RepositoryContext {
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly remoteName: string;
  readonly workspaceFolderUri: string;
  readonly defaultBranch?: string;
  readonly authenticatedUserId?: string;
}

export type Capability =
  | { readonly state: "available" }
  | { readonly state: "authentication_required" }
  | { readonly state: "permission_restricted"; readonly reason: string }
  | { readonly state: "temporarily_unavailable"; readonly reason: string };

export function repositoryContextId(owner: string, repo: string, remoteName: string, folderUri: string): string {
  return JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), remoteName, folderUri]);
}
