import * as vscode from "vscode";
import type {
  CopilotConfirmationPort,
  CopilotExecutionProposal,
} from "../../application/copilot/execution-tools";
import { isSensitiveInputName } from "../../domain/services/plan-transitions";
import { redactSensitiveText } from "../../domain/services/redaction";

const MAX_DISPLAY_VALUE = 1_000;

function displayValue(name: string, value: string): string {
  if (isSensitiveInputName(name)) return "[sensitive]";
  const clean = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  return clean.length > MAX_DISPLAY_VALUE ? `${clean.slice(0, MAX_DISPLAY_VALUE)}…` : clean;
}

export function formatCopilotConfirmationDetail(proposal: CopilotExecutionProposal): string {
  const parameters = Object.entries(proposal.effectiveParameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `  ${name} = ${displayValue(name, value)}`);
  return [
    `Action: ${proposal.action}`,
    `Repository: ${proposal.repositoryId}`,
    `Target: ${displayValue("target", proposal.targetLabel)}`,
    `Ref/Environment: ${displayValue("ref", proposal.refOrEnvironment)}`,
    "Effective parameters:",
    ...(parameters.length > 0 ? parameters : ["  (none)"]),
  ].join("\n");
}

export class VsCodeCopilotConfirmation implements CopilotConfirmationPort {
  async confirm(proposal: CopilotExecutionProposal): Promise<{ readonly approved: boolean }> {
    const choice = await vscode.window.showWarningMessage(
      "Confirm ActionDeck Copilot execution?",
      { modal: true, detail: formatCopilotConfirmationDetail(proposal) },
      "Approve Execution",
    );
    return { approved: choice === "Approve Execution" };
  }
}
