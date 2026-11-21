import * as vscode from "vscode";
import { parseDocument } from "yaml";
import { join } from "node:path/posix";

export const PROPOSAL_SCHEME = "actiondeck-proposal";

export interface YamlFixSpec {
  readonly setAtPath?: {
    readonly path: readonly (string | number)[];
    readonly value: unknown;
  };
  readonly replaceText?: {
    readonly search: string;
    readonly replace: string;
  };
}

export function proposeCommentPreservingYamlFix(
  originalYaml: string,
  spec: YamlFixSpec,
): { changed: boolean; content: string } {
  if (spec.setAtPath) {
    const doc = parseDocument(originalYaml, { keepSourceTokens: true });
    if (doc.errors.length === 0) {
      doc.setIn([...spec.setAtPath.path], spec.setAtPath.value);
      const updated = doc.toString();
      return {
        changed: updated !== originalYaml,
        content: updated,
      };
    }
  }
  if (spec.replaceText && spec.replaceText.search && originalYaml.includes(spec.replaceText.search)) {
    const updated = originalYaml.replace(spec.replaceText.search, spec.replaceText.replace);
    return {
      changed: updated !== originalYaml,
      content: updated,
    };
  }
  return {
    changed: false,
    content: originalYaml,
  };
}

export class WorkflowProposalProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  setProposal(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

export async function openWorkflowFixDiff(params: {
  provider: WorkflowProposalProvider;
  workspaceFolderUri: string;
  workflowPath: string;
  proposedContent: string;
  title?: string;
}): Promise<{ applied: boolean; targetUri: vscode.Uri; proposalUri: vscode.Uri }> {
  const folderUri = vscode.Uri.parse(params.workspaceFolderUri);
  const relativeSegments = params.workflowPath.replace(/^\/+/, "").split("/").filter(Boolean);
  const targetUri = vscode.Uri.joinPath(folderUri, ...relativeSegments);

  // Preserve unsaved local edits by reading from an open document if present.
  const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === targetUri.toString());
  if (!openDoc) {
    await vscode.workspace.openTextDocument(targetUri);
  }

  const proposalUri = vscode.Uri.from({
    scheme: PROPOSAL_SCHEME,
    path: join("/", ...relativeSegments),
    query: `ts=${Date.now()}`,
  });
  params.provider.setProposal(proposalUri, params.proposedContent);

  await vscode.commands.executeCommand(
    "vscode.diff",
    targetUri,
    proposalUri,
    params.title ?? `ActionDeck Proposed Fix: ${params.workflowPath}`,
  );

  // Explicit user review is required before applying; never auto-apply, commit, push, or dispatch.
  const choice = await vscode.window.showInformationMessage(
    `Review proposed YAML fix for ${params.workflowPath}. Apply changes to your local buffer?`,
    "Apply Fix",
    "Dismiss",
  );
  if (choice !== "Apply Fix") {
    return { applied: false, targetUri, proposalUri };
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(doc.getText().length),
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(targetUri, fullRange, params.proposedContent);
  const applied = await vscode.workspace.applyEdit(edit);
  return { applied, targetUri, proposalUri };
}
