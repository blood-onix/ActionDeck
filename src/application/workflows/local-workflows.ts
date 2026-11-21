import * as vscode from "vscode";
import type { LocalWorkflow } from "../../domain/models/workflow";
import { workflowFolder } from "../../domain/services/workflow-folders";
import { inspectWorkflowYaml } from "../../domain/services/workflow-parser";

function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(path);
}

export async function discoverLocalWorkflows(
  folder: vscode.WorkspaceFolder,
  prefixes: readonly string[] = [],
): Promise<LocalWorkflow[]> {
  const root = vscode.Uri.joinPath(folder.uri, ".github", "workflows");
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return [];
    throw error;
  }

  const workflows: LocalWorkflow[] = [];
  for (const [fileName, type] of entries) {
    if (type !== vscode.FileType.File || !/\.(?:yml|yaml)$/i.test(fileName)) continue;
    const uri = vscode.Uri.joinPath(root, fileName);
    const path = `.github/workflows/${fileName}`;
    const bytes = await vscode.workspace.fs.readFile(uri);
    const source = new TextDecoder().decode(bytes);
    const inspection = inspectWorkflowYaml(source);
    const diagnostic = inspection.diagnostic;
    workflows.push({
      path,
      name: fileName.replace(/\.(?:yml|yaml)$/i, ""),
      folder: workflowFolder(source, fileName, prefixes),
      dispatchable: !diagnostic && inspection.dispatchable,
      ...(!diagnostic && inspection.reusable ? { reusable: true } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
  return workflows;
}
