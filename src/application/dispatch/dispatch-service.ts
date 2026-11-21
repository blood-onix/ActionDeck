import type { DispatchTarget, DispatchInputValidation } from "../../domain/models/dispatch";
import type { RepositoryContext } from "../../domain/models/repository";
import type { WorkflowRunRecord } from "../../domain/models/run";
import type { UiExecutionAuthorization } from "./authorization";
import { AppError } from "../../domain/models/errors";
import { validateRemoteDispatchInputs } from "./dispatch-validation";
import { associateDispatchRun } from "./run-association";
import { classifyGitHubError } from "../../github/client/classify-error";

export interface DispatchSubmissionRepository {
  loadTarget(workflowId: number, ref: string, signal?: AbortSignal): Promise<DispatchTarget>;
  submit(
    workflowId: number,
    ref: string,
    inputs: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<void>;
  listAssociationCandidates(
    workflowId: number,
    submittedAt: number,
    acceptedAt: number,
    signal?: AbortSignal,
  ): Promise<{ runs: WorkflowRunRecord[]; partial: boolean }>;
}

export interface DispatchClock {
  now(): number;
}

export type DispatchResult =
  | {
    readonly state: "request_accepted";
    readonly association: "not_observed" | "unavailable";
    readonly submittedAt: number;
    readonly acceptedAt: number;
  }
  | {
    readonly state: "associated_run_found";
    readonly runId: number;
    readonly runStatus: string;
    readonly htmlUrl: string;
  }
  | {
    readonly state: "completed";
    readonly runId: number;
    readonly conclusion: string | null;
    readonly htmlUrl: string;
  }
  | {
    readonly state: "outcome_uncertain";
    readonly reconciliation: "not_observed" | "ambiguous" | "unavailable";
  };

export async function checkDispatchAssociation(
  repository: DispatchSubmissionRepository,
  context: RepositoryContext,
  request: {
    readonly workflowId: number;
    readonly ref: string;
    readonly submittedAt: number;
    readonly acceptedAt: number;
  },
  signal?: AbortSignal,
): Promise<DispatchResult> {
  if (
    !Number.isInteger(request.workflowId) ||
    request.workflowId < 1 ||
    !Number.isFinite(request.submittedAt) ||
    !Number.isFinite(request.acceptedAt) ||
    request.acceptedAt < request.submittedAt
  ) {
    throw new AppError("invalid_input", "Dispatch association request is invalid.");
  }
  const association = await findAssociation(
    repository,
    request.workflowId,
    request.ref,
    context.authenticatedUserId,
    request.submittedAt,
    request.acceptedAt,
    signal,
  );
  if (association.state === "associated_run_found") return projectRun(association.run);
  if (association.state === "ambiguous") {
    return { state: "outcome_uncertain", reconciliation: "ambiguous" };
  }
  return {
    state: "request_accepted",
    association: association.state === "unavailable" ? "unavailable" : "not_observed",
    submittedAt: request.submittedAt,
    acceptedAt: request.acceptedAt,
  };
}

export async function executeDispatch(
  repository: DispatchSubmissionRepository,
  context: RepositoryContext,
  authorization: UiExecutionAuthorization,
  request: {
    readonly workflowId: number;
    readonly ref: string;
    readonly inputs: Readonly<Record<string, string>>;
  },
  clock: DispatchClock = { now: () => Date.now() },
  signal?: AbortSignal,
): Promise<DispatchResult> {
  if (!Number.isInteger(request.workflowId) || request.workflowId < 1) {
    throw new AppError("invalid_input", "A remote workflow ID is required.");
  }
  const target = await repository.loadTarget(request.workflowId, request.ref, signal);
  if (target.state !== "available") {
    throw new AppError("invalid_input", target.reason);
  }
  const validation = validateRemoteDispatchInputs(target, request.inputs);
  if (!validation.valid) {
    throw new AppError("invalid_input", validationMessage(validation));
  }
  if (!authorization.consume({
    repositoryId: context.id,
    target: `workflow:${request.workflowId}`,
    ref: request.ref,
    inputs: validation.values,
  })) {
    throw new AppError("permission_restricted", "Dispatch was not authorized for the exact reviewed ref and inputs.");
  }
  if (signal?.aborted) throw new AppError("cancelled", "Dispatch was cancelled before submission.");

  const submittedAt = clock.now();
  try {
    await repository.submit(request.workflowId, request.ref, validation.values, signal);
  } catch (error) {
    const failure = error instanceof AppError ? error : classifyGitHubError(error);
    if (failure.code !== "network" && failure.code !== "service") throw failure;
    const acceptedAt = clock.now();
    const reconciliation = await reconcile(
      repository,
      target,
      context,
      submittedAt,
      acceptedAt,
      signal,
    );
    if (reconciliation.state === "associated_run_found") return projectRun(reconciliation.run);
    if (reconciliation.state === "ambiguous") {
      return { state: "outcome_uncertain", reconciliation: "ambiguous" };
    }
    return {
      state: "outcome_uncertain",
      reconciliation: reconciliation.state === "unavailable" ? "unavailable" : "not_observed",
    };
  }

  const acceptedAt = clock.now();
  const reconciliation = await reconcile(
    repository,
    target,
    context,
    submittedAt,
    acceptedAt,
    signal,
  );
  if (reconciliation.state === "associated_run_found") return projectRun(reconciliation.run);
  if (reconciliation.state === "ambiguous") {
    return { state: "outcome_uncertain", reconciliation: "ambiguous" };
  }
  return {
    state: "request_accepted",
    association: reconciliation.state === "unavailable" ? "unavailable" : "not_observed",
    submittedAt,
    acceptedAt,
  };
}

async function reconcile(
  repository: DispatchSubmissionRepository,
  target: Extract<DispatchTarget, { state: "available" }>,
  context: RepositoryContext,
  submittedAt: number,
  acceptedAt: number,
  signal?: AbortSignal,
) {
  return findAssociation(
    repository,
    target.workflowId,
    target.ref,
    context.authenticatedUserId,
    submittedAt,
    acceptedAt,
    signal,
  );
}

async function findAssociation(
  repository: DispatchSubmissionRepository,
  workflowId: number,
  ref: string,
  authenticatedUserId: string | undefined,
  submittedAt: number,
  acceptedAt: number,
  signal?: AbortSignal,
) {
  if (!authenticatedUserId) return { state: "unavailable" as const };
  try {
    const result = await repository.listAssociationCandidates(
      workflowId,
      submittedAt,
      acceptedAt,
      signal,
    );
    const association = associateDispatchRun(result.runs, {
      workflowId,
      ref,
      authenticatedUserId,
      submittedAt,
      acceptedAt,
    });
    if (result.partial && association.state !== "ambiguous") {
      return { state: "ambiguous" as const };
    }
    return association;
  } catch (error) {
    const failure = error instanceof AppError ? error : classifyGitHubError(error);
    if (
      failure.code === "authentication_required" ||
      failure.code === "auth_or_org_required" ||
      failure.code === "inaccessible" ||
      failure.code === "permission_restricted" ||
      failure.code === "rate_limited" ||
      failure.code === "cancelled" ||
      failure.code === "network" ||
      failure.code === "service"
    ) {
      return { state: "unavailable" as const };
    }
    throw failure;
  }
}

function projectRun(run: WorkflowRunRecord): DispatchResult {
  if (run.status === "completed") {
    return {
      state: "completed",
      runId: run.id,
      conclusion: run.conclusion,
      htmlUrl: run.htmlUrl,
    };
  }
  return {
    state: "associated_run_found",
    runId: run.id,
    runStatus: run.status,
    htmlUrl: run.htmlUrl,
  };
}

function validationMessage(validation: DispatchInputValidation): string {
  const messages = Object.values(validation.errors);
  return messages.length > 0
    ? `Dispatch inputs are invalid: ${messages.join(" ")}`
    : "Dispatch inputs are invalid for the selected remote workflow ref.";
}
