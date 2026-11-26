import * as vscode from "vscode";
import { copilotExecutionToolSchemas, type CopilotExecutionToolName } from "../../protocol/copilot";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import { redactSensitiveText } from "../../domain/services/redaction";
import { executeConfirmedCopilotAction } from "../../application/copilot/execution-tools";
import { executeDispatch } from "../../application/dispatch/dispatch-service";
import { executeRunAction } from "../../application/runs/run-actions";
import { reviewPendingDeployments } from "../../application/approvals/approval-service";
import { UiAuthorization } from "../../application/dispatch/authorization";
import { JobRepository } from "../../github/repositories/job-repository";
import { PlanStore } from "../../persistence/plan-store";
import { ReleasePlanService } from "../../application/plans/plan-service";
import type { ReleasePlan } from "../../domain/models/release-plan";
import {
  currentPlanReview,
  resolveDeploymentReview,
  resolveDispatchAction,
  resolvePlanStart,
  resolveRunAction,
  type ResolvedCopilotAction,
} from "../../application/copilot/execution-targets";
import { createGitHubClient } from "../../github/client/github-client";
import { DispatchRepository } from "../../github/repositories/dispatch-repository";
import { DeploymentRepository } from "../../github/repositories/deployment-repository";
import { RepositoryScheduler } from "../../github/rate-limit/repository-scheduler";
import { getGitHubSession, withPrivateRepositoryEscalation } from "./github-authentication";
import { VsCodeCopilotConfirmation } from "./copilot-confirmation";

export interface ExecutionToolContextProvider {
  getActiveContext(): RepositoryContext | undefined;
  getScheduler(): RepositoryScheduler;
  getPlanStore(): PlanStore;
  getPlanService(): ReleasePlanService;
}

function asResult(payload: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(redactSensitiveText(JSON.stringify(payload, null, 2))),
  ]);
}

export function registerCopilotExecutionTools(
  context: vscode.ExtensionContext,
  provider: ExecutionToolContextProvider,
): void {
  if (!vscode.lm || typeof vscode.lm.registerTool !== "function") return;
  const confirmation = new VsCodeCopilotConfirmation();

  const register = <T>(
    name: CopilotExecutionToolName,
    handler: (input: T, signal: AbortSignal) => Promise<unknown>,
  ) => {
    const schema = copilotExecutionToolSchemas[name];
    const disposable = vscode.lm.registerTool<T>(name, {
      async invoke(options, token) {
        const parsed = schema.safeParse(options.input);
        if (!parsed.success) {
          throw new AppError("invalid_input", `Invalid input for ${name}.`);
        }
        const controller = new AbortController();
        if (token.isCancellationRequested) controller.abort();
        token.onCancellationRequested(() => controller.abort());
        const result = await handler(parsed.data as T, controller.signal);
        return asResult(result);
      },
    });
    context.subscriptions.push(disposable);
  };

  register("actiondeck_dispatch_workflow", async (input: {
    repositoryId: string;
    workflowId: number;
    ref: string;
    inputs: Record<string, string>;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    const { repo, resolved } = await withPrivateRepositoryEscalation(
      session,
      async (active) => {
        const dispatchRepo = new DispatchRepository(scheduler, repoContext, active.accessToken);
        return {
          repo: dispatchRepo,
          resolved: await resolveDispatchAction(repoContext, dispatchRepo, input, signal),
        };
      },
      signal,
    );
    return executeConfirmedCopilotAction(
      repoContext,
      resolved.proposal,
      confirmation,
      (bound) => {
        const auth = authorizeReviewed(resolved);
        return executeDispatch(repo, repoContext, auth, {
          workflowId: input.workflowId,
          ref: bound.refOrEnvironment,
          inputs: bound.effectiveParameters,
        }, undefined, signal);
      },
    );
  });

  register("actiondeck_run_action", async (input: {
    repositoryId: string;
    action: "cancel" | "rerun_failed_jobs" | "rerun_all";
    runId: number;
    attempt: number;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    const { client, resolved } = await withPrivateRepositoryEscalation(
      session,
      async (active) => {
        const jobRepo = new JobRepository(scheduler, repoContext, active.accessToken);
        const ghClient = createGitHubClient(
          active.accessToken,
          (retryAfter) => scheduler.defer(repoContext.id, retryAfter * 1000),
        );
        return {
          client: ghClient,
          resolved: await resolveRunAction(repoContext, jobRepo, input, signal),
        };
      },
      signal,
    );
    return executeConfirmedCopilotAction(
      repoContext,
      resolved.proposal,
      confirmation,
      () => executeRunAction(client, repoContext, authorizeReviewed(resolved), input, signal),
    );
  });

  register("actiondeck_review_deployment", async (input: {
    repositoryId: string;
    runId: number;
    environmentIds: number[];
    state: "approved" | "rejected";
    comment?: string;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    const { repo, resolved } = await withPrivateRepositoryEscalation(
      session,
      async (active) => {
        const deploymentRepo = new DeploymentRepository(scheduler, repoContext, active.accessToken);
        const jobRepo = new JobRepository(scheduler, repoContext, active.accessToken);
        return {
          repo: deploymentRepo,
          resolved: await resolveDeploymentReview(repoContext, jobRepo, deploymentRepo, input, signal),
        };
      },
      signal,
    );
    return executeConfirmedCopilotAction(
      repoContext,
      resolved.proposal,
      confirmation,
      (bound) => reviewPendingDeployments(
        repo,
        repoContext,
        authorizeReviewed(resolved),
        {
          runId: input.runId,
          environmentIds: resolved.environmentIds,
          state: bound.refOrEnvironment as "approved" | "rejected",
          comment: bound.effectiveParameters["comment"] ?? "",
        },
        signal,
      ),
    );
  });

  register("actiondeck_start_plan", async (input: {
    repositoryId: string;
    planId: string;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    const planStore = provider.getPlanStore();
    const { repo, resolved } = await withPrivateRepositoryEscalation(
      session,
      async (active) => {
        const dispatchRepo = new DispatchRepository(scheduler, repoContext, active.accessToken);
        return {
          repo: dispatchRepo,
          resolved: await resolvePlanStart(repoContext, planStore, dispatchRepo, input.planId, signal),
        };
      },
      signal,
    );
    return executeConfirmedCopilotAction(
      repoContext,
      resolved.proposal,
      confirmation,
      async () => {
        const auth = authorizeReviewed(resolved);
        if (!auth.consume(currentPlanReview(repoContext, planStore, input.planId))) {
          throw new AppError("stale", "The release plan changed after confirmation. Review and start it again.");
        }
        return summarizePlan(await provider.getPlanService().startPlan(repo, repoContext, input.planId, undefined, signal));
      },
    );
  });
}

function authorizeReviewed(resolved: ResolvedCopilotAction): UiAuthorization {
  const auth = new UiAuthorization();
  auth.authorize(resolved.reviewed);
  return auth;
}

function summarizePlan(plan: ReleasePlan) {
  return {
    id: plan.id,
    name: plan.name,
    state: plan.state,
    currentStepIndex: plan.currentStepIndex,
    ...(plan.blockedReason ? { blockedReason: plan.blockedReason } : {}),
    steps: plan.steps.map((step) => ({
      id: step.id,
      workflowPath: step.workflowPath,
      ref: step.ref,
      state: step.state,
      ...(step.runId !== undefined ? { runId: step.runId } : {}),
      ...(step.error ? { error: step.error } : {}),
    })),
  };
}

async function requireActiveRepository(
  provider: ExecutionToolContextProvider,
  repositoryId: string,
): Promise<{ repoContext: RepositoryContext; session: vscode.AuthenticationSession; scheduler: RepositoryScheduler }> {
  const repoContext = provider.getActiveContext();
  if (!repoContext || repoContext.id !== repositoryId) {
    throw new AppError("invalid_input", "The requested repositoryId does not match the active repository.");
  }
  const session = await getGitHubSession(false);
  if (!session) {
    throw new AppError("authentication_required", "GitHub authentication is required.");
  }
  if (repoContext.authenticatedUserId && session.account.id !== repoContext.authenticatedUserId) {
    throw new AppError("stale", "The GitHub identity changed since this repository was selected. Reselect the repository.");
  }
  return {
    repoContext,
    session,
    scheduler: provider.getScheduler(),
  };
}
