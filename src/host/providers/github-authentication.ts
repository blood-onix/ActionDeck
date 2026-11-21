import * as vscode from "vscode";
import { AppError } from "../../domain/models/errors";
import { classifyGitHubError } from "../../github/client/classify-error";

const elevatedTokens = new Set<string>();

export async function getGitHubSession(interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
  const elevated = await vscode.authentication.getSession("github", ["read:user", "repo"], { createIfNone: false });
  if (elevated) {
    elevatedTokens.add(elevated.accessToken);
    return elevated;
  }
  return vscode.authentication.getSession("github", ["read:user"], { createIfNone: interactive });
}

export function hasPrivateRepositoryAccess(session?: vscode.AuthenticationSession): boolean {
  if (!session) return false;
  return session.scopes?.includes("repo") || elevatedTokens.has(session.accessToken);
}

export async function requestPrivateRepositoryAccess(): Promise<vscode.AuthenticationSession | undefined> {
  const confirmed = await vscode.window.showWarningMessage(
    "Private GitHub Actions data may require the broader repository scope.",
    { modal: true },
    "Continue to GitHub sign-in",
  );
  if (!confirmed) return undefined;
  const session = await vscode.authentication.getSession("github", ["read:user", "repo"], { createIfNone: true });
  if (session) {
    elevatedTokens.add(session.accessToken);
  }
  return session;
}

export async function withPrivateRepositoryEscalation<T>(
  currentSession: vscode.AuthenticationSession,
  operation: (session: vscode.AuthenticationSession) => Promise<T>,
  signal?: AbortSignal,
  onElevated?: (elevated: vscode.AuthenticationSession) => void,
): Promise<T> {
  try {
    return await operation(currentSession);
  } catch (error) {
    const classified = error instanceof AppError ? error : classifyGitHubError(error);
    if (classified.code !== "inaccessible" || signal?.aborted || hasPrivateRepositoryAccess(currentSession)) {
      throw classified;
    }
    const elevated = await requestPrivateRepositoryAccess();
    if (!elevated) throw classified;
    if (elevated.account.id !== currentSession.account.id) {
      throw new AppError("authentication_required", "GitHub identity changed. Reopen the dashboard to continue.");
    }
    onElevated?.(elevated);
    return operation(elevated);
  }
}
