import type { RepositoryContext } from "../../domain/models/repository";
import type { UiExecutionAuthorization } from "../dispatch/authorization";
import { AppError } from "../../domain/models/errors";
import { classifyGitHubError } from "../../github/client/classify-error";

type RunAction = "cancel" | "rerun_failed_jobs" | "rerun_all";
interface RunActionClient {
  rest: {
    actions: {
      getWorkflowRun(parameters: {
        owner: string;
        repo: string;
        run_id: number;
        request?: { retries?: number; retryAfter?: number; signal?: AbortSignal };
      }): Promise<{ data: { id: number; run_attempt?: number; status: string | null; conclusion: string | null } }>;
      cancelWorkflowRun(parameters: { owner: string; repo: string; run_id: number }): Promise<unknown>;
      reRunWorkflowFailedJobs(parameters: { owner: string; repo: string; run_id: number }): Promise<unknown>;
      reRunWorkflow(parameters: { owner: string; repo: string; run_id: number }): Promise<unknown>;
    };
  };
}

export async function executeRunAction(
  client: RunActionClient,
  repository: RepositoryContext,
  authorization: UiExecutionAuthorization,
  request: { action: RunAction; runId: number; attempt: number },
  signal?: AbortSignal,
): Promise<{ state: "accepted" } | { state: "outcome_uncertain"; reconciliation: "not_observed" | "unavailable" }> {
  if (!Number.isInteger(request.runId) || request.runId < 1 || !Number.isInteger(request.attempt) || request.attempt < 1) {
    throw new AppError("invalid_input", "Run action identity is invalid.");
  }
  const reviewed = {
    repositoryId: repository.id,
    target: `${request.action}:run:${request.runId}:attempt:${request.attempt}`,
    ref: "",
    inputs: {},
  };
  if (!authorization.consume(reviewed)) {
    throw new AppError("permission_restricted", "This run action was not authorized for the exact selected target.");
  }

  const observed = await client.rest.actions.getWorkflowRun({
    owner: repository.owner,
    repo: repository.repo,
    run_id: request.runId,
    request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
  });
  if (signal?.aborted) throw new AppError("cancelled", "Run action was cancelled before submission.");
  if (observed.data.id !== request.runId || (observed.data.run_attempt ?? 1) !== request.attempt) {
    throw new AppError("stale", "The selected run attempt changed. Refresh and review the action again.");
  }
  if (request.action === "cancel" && observed.data.status === "completed") {
    throw new AppError("invalid_input", "A completed run cannot be cancelled.");
  }
  if (request.action === "rerun_failed_jobs" && observed.data.status !== "completed") {
    throw new AppError("invalid_input", "Failed jobs can be rerun only after the run completes.");
  }
  if (request.action === "rerun_all" && observed.data.status !== "completed") {
    throw new AppError("invalid_input", "All jobs can be rerun only after the run completes.");
  }

  try {
    if (request.action === "cancel") {
      await client.rest.actions.cancelWorkflowRun({
        owner: repository.owner,
        repo: repository.repo,
        run_id: request.runId,
      });
    } else if (request.action === "rerun_all") {
      await client.rest.actions.reRunWorkflow({
        owner: repository.owner,
        repo: repository.repo,
        run_id: request.runId,
      });
    } else {
      await client.rest.actions.reRunWorkflowFailedJobs({
        owner: repository.owner,
        repo: repository.repo,
        run_id: request.runId,
      });
    }
    return { state: "accepted" };
  } catch (error) {
    const failure = error instanceof AppError ? error : classifyGitHubError(error);
    if (failure.code !== "network" && failure.code !== "service") throw failure;

    try {
      const current = await client.rest.actions.getWorkflowRun({
        owner: repository.owner,
        repo: repository.repo,
        run_id: request.runId,
      });
      if (
        request.action !== "cancel" &&
        current.data.id === request.runId &&
        (current.data.run_attempt ?? 1) > request.attempt
      ) {
        return { state: "accepted" };
      }
      return { state: "outcome_uncertain", reconciliation: "not_observed" };
    } catch {
      return { state: "outcome_uncertain", reconciliation: "unavailable" };
    }
  }
}
