import * as vscode from "vscode";
import { registerDashboardCommands } from "./host/commands/dashboard-commands";
import { registerCopilotReadTools } from "./host/providers/copilot-read-tools";
import { registerCopilotExecutionTools } from "./host/providers/copilot-execution-tools";
import { registerCopilotCommands } from "./host/commands/copilot-commands";
import { PROPOSAL_SCHEME, WorkflowProposalProvider } from "./host/providers/workflow-diff";

export function activate(context: vscode.ExtensionContext): void {
  const proposalProvider = new WorkflowProposalProvider();
  context.subscriptions.push(
    proposalProvider,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposalProvider),
  );
  const runtime = registerDashboardCommands(context, proposalProvider);
  registerCopilotReadTools(context, runtime);
  registerCopilotExecutionTools(context, runtime);
  registerCopilotCommands(context, proposalProvider, runtime.getActiveContext, runtime.getScheduler());
}

export function deactivate(): void {}
