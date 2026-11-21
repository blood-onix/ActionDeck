import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";

export interface CopilotExecutionProposal {
  readonly action: "dispatch_workflow" | "run_action" | "review_deployment" | "start_plan";
  readonly repositoryId: string;
  readonly targetLabel: string;
  readonly refOrEnvironment: string;
  readonly effectiveParameters: Readonly<Record<string, string>>;
}

export interface CopilotConfirmationPort {
  confirm(proposal: CopilotExecutionProposal): Promise<{ readonly approved: boolean }>;
}

export async function executeConfirmedCopilotAction<T>(
  context: RepositoryContext,
  proposal: CopilotExecutionProposal,
  confirmation: CopilotConfirmationPort,
  execute: (bound: CopilotExecutionProposal) => Promise<T>,
): Promise<{ readonly executed: true; readonly result: T } | { readonly executed: false; readonly reason: string }> {
  if (proposal.repositoryId !== context.id) {
    throw new AppError("invalid_input", "Execution target does not match the active repository context.");
  }
  // Confirmation and execution see the same frozen snapshot, so parameters cannot change after approval.
  const bound = freezeProposal(proposal);
  const decision = await confirmation.confirm(bound);
  if (!decision.approved) {
    return { executed: false, reason: "Action was declined or cancelled by the user." };
  }
  const result = await execute(bound);
  return { executed: true, result };
}

function freezeProposal(proposal: CopilotExecutionProposal): CopilotExecutionProposal {
  return Object.freeze({
    ...proposal,
    effectiveParameters: Object.freeze({ ...proposal.effectiveParameters }),
  });
}
