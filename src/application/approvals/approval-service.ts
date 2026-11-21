import type { RepositoryContext } from "../../domain/models/repository";
import type { DeploymentReviewItemResult, PendingEnvironment } from "../../domain/models/approval";
import type { WorkflowRunRecord } from "../../domain/models/run";
import { AppError } from "../../domain/models/errors";
import { redactSensitiveText } from "../../domain/services/redaction";
import { UiAuthorization } from "../dispatch/authorization";

export interface PendingDeploymentSummary {
  readonly runId: number;
  readonly workflowId?: number;
  readonly displayTitle: string;
  readonly branch: string;
  readonly htmlUrl: string;
  readonly environments: readonly PendingEnvironment[];
}

export async function listPendingDeploymentSummaries(
  runLoader: { loadRecent(signal?: AbortSignal): Promise<{ runs: readonly WorkflowRunRecord[] }> },
  deploymentPort: { listPendingDeployments(runId: number, signal?: AbortSignal): Promise<PendingEnvironment[]> },
  signal?: AbortSignal,
): Promise<PendingDeploymentSummary[]> {
  const recent = await runLoader.loadRecent(signal);
  const waitingRuns = recent.runs.filter((run) => run.status === "waiting").slice(0, 10);
  const summaries: PendingDeploymentSummary[] = [];
  for (const run of waitingRuns) {
    try {
      const environments = await deploymentPort.listPendingDeployments(run.id, signal);
      if (environments.length > 0) {
        summaries.push({
          runId: run.id,
          ...(run.workflowId !== undefined ? { workflowId: run.workflowId } : {}),
          displayTitle: redactSensitiveText(run.displayTitle),
          branch: run.branch,
          htmlUrl: run.htmlUrl,
          environments,
        });
      }
    } catch {
      // Skip individual run if pending deployment query is restricted or unavailable.
    }
  }
  return summaries;
}

export interface DeploymentReviewPort {
  submitReview(
    runId: number,
    environmentId: number,
    state: "approved" | "rejected",
    comment: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export async function reviewPendingDeployments(
  repository: DeploymentReviewPort,
  context: RepositoryContext,
  authorization: UiAuthorization,
  request: {
    readonly runId: number;
    readonly environmentIds: readonly number[];
    readonly state: "approved" | "rejected";
    readonly comment?: string;
  },
  signal?: AbortSignal,
): Promise<DeploymentReviewItemResult[]> {
  if (request.environmentIds.length === 0) {
    throw new AppError("invalid_input", "Select at least one environment to review.");
  }

  const target = `review:run:${request.runId}:envs:${request.environmentIds.join(",")}`;
  if (!authorization.consume({
    repositoryId: context.id,
    target,
    ref: request.state,
    inputs: { comment: request.comment ?? "" },
  })) {
    throw new AppError("permission_restricted", "Deployment review authorization does not match the selected environments.");
  }

  const results: DeploymentReviewItemResult[] = [];
  for (const environmentId of request.environmentIds) {
    try {
      await repository.submitReview(
        request.runId,
        environmentId,
        request.state,
        request.comment ?? "",
        signal,
      );
      results.push({ environmentId, status: "succeeded" });
    } catch (error) {
      const uncertain = error instanceof AppError && (error.code === "network" || error.code === "service");
      results.push({
        environmentId,
        status: uncertain ? "outcome_uncertain" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
