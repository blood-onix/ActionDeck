import * as vscode from "vscode";
import { copilotReadToolSchemas, type CopilotReadToolName } from "../../protocol/copilot";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import { redactSensitiveText } from "../../domain/services/redaction";
import { collectCopilotEvidence } from "../../application/copilot/evidence-service";
import { inspectRun } from "../../application/runs/inspection-service";
import { validateRemoteDispatchInputs } from "../../application/dispatch/dispatch-validation";
import { WorkflowRepository } from "../../github/repositories/workflow-repository";
import { RunRepository } from "../../github/repositories/run-repository";
import { JobRepository } from "../../github/repositories/job-repository";
import { DispatchRepository } from "../../github/repositories/dispatch-repository";
import { DeploymentRepository } from "../../github/repositories/deployment-repository";
import { listPendingDeploymentSummaries } from "../../application/approvals/approval-service";
import { RepositoryScheduler } from "../../github/rate-limit/repository-scheduler";
import { PlanStore } from "../../persistence/plan-store";
import { getGitHubSession, hasPrivateRepositoryAccess, withPrivateRepositoryEscalation } from "./github-authentication";
import { classifyGitHubError } from "../../github/client/classify-error";
import { workflowPathFromRunPath } from "../../domain/services/workflow-run-path";

export interface ReadToolContextProvider {
  getActiveContext(): RepositoryContext | undefined;
  getScheduler(): RepositoryScheduler;
}

function asToolResult(payload: unknown): vscode.LanguageModelToolResult {
  const sanitized = redactSensitiveText(JSON.stringify(payload, null, 2));
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(sanitized)]);
}

function toCancellationSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

export function registerCopilotReadTools(
  context: vscode.ExtensionContext,
  provider: ReadToolContextProvider,
): void {
  if (!vscode.lm || typeof vscode.lm.registerTool !== "function") return;

  const register = <T>(
    name: CopilotReadToolName,
    handler: (input: T, signal: AbortSignal) => Promise<unknown>,
  ) => {
    const schema = copilotReadToolSchemas[name];
    const disposable = vscode.lm.registerTool<T>(name, {
      async invoke(options, token) {
        const parsed = schema.safeParse(options.input);
        if (!parsed.success) {
          throw new AppError("invalid_input", `Invalid input for ${name}.`);
        }
        const signal = toCancellationSignal(token);
        const result = await handler(parsed.data as T, signal);
        return asToolResult(result);
      },
    });
    context.subscriptions.push(disposable);
  };

  register("actiondeck_list_workflows", async (input: { repositoryId: string; filter?: string; limit?: number }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    const inventory = await withPrivateRepositoryEscalation(
      session,
      (active) => new WorkflowRepository(scheduler, repoContext, active.accessToken).load(signal),
      signal,
    );
    const needle = input.filter?.trim().toLowerCase();
    const filtered = needle
      ? inventory.workflows.filter((w) =>
          w.name.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle),
        )
      : inventory.workflows;
    return {
      repositoryId: repoContext.id,
      partial: inventory.partial,
      workflows: filtered.slice(0, input.limit ?? 50).map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state,
      })),
    };
  });

  register("actiondeck_inspect_run", async (input: { repositoryId: string; runId: number; attempt: number }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    return withPrivateRepositoryEscalation(
      session,
      (active) => inspectRun(new JobRepository(scheduler, repoContext, active.accessToken), input.runId, input.attempt, signal),
      signal,
    );
  });

  register("actiondeck_get_log_excerpt", async (input: {
    repositoryId: string;
    workflowId: number;
    runId: number;
    attempt: number;
    jobId: number;
    stepNumber?: number;
    ref: string;
    maxLines?: number;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    return withPrivateRepositoryEscalation(
      session,
      (active) => collectCopilotEvidence(new JobRepository(scheduler, repoContext, active.accessToken), repoContext, input, signal),
      signal,
    );
  });

  register("actiondeck_get_workflow_revision", async (input: {
    repositoryId: string;
    workflowId: number;
    runId?: number;
    attempt?: number;
    ref?: string;
    sha?: string;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    return withPrivateRepositoryEscalation(
      session,
      async (active) => {
        const jobRepo = new JobRepository(scheduler, repoContext, active.accessToken);
        const workflowRepo = new WorkflowRepository(scheduler, repoContext, active.accessToken);
        const explicitRef = input.sha ?? input.ref;
        let runPath: string | undefined;
        const refCandidates: string[] = explicitRef ? [explicitRef] : [];
        if (input.runId) {
          const run = await jobRepo.getRun(input.runId, signal);
          runPath = workflowPathFromRunPath(run.path);
          if (run.head_sha) refCandidates.push(run.head_sha);
          if (run.head_branch) refCandidates.push(run.head_branch);
        }
        let inventoryPath: string | undefined;
        const resolveInventoryPath = async () => {
          if (inventoryPath === undefined) {
            const inventory = await workflowRepo.load(signal);
            const found = inventory.workflows.find((w) => w.id === input.workflowId)?.path;
            inventoryPath = found ? workflowPathFromRunPath(found) ?? found : "";
          }
          return inventoryPath || undefined;
        };
        const pathCandidates = [...new Set([runPath ?? (await resolveInventoryPath())].filter((p): p is string => Boolean(p)))];
        const refs = [...new Set(refCandidates)];
        if (pathCandidates.length === 0 || refs.length === 0) {
          return {
            state: "unavailable",
            reason: pathCandidates.length === 0
              ? `Workflow ${input.workflowId} has no readable workflow file path.`
              : "No revision to read: pass ref or sha, or a runId.",
          };
        }
        const failures: string[] = [];
        let allInaccessible = true;
        let lastError: AppError | undefined;
        const tryRead = async (path: string, ref: string) => {
          try {
            return await jobRepo.getWorkflowSource(path, ref, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            const classified = error instanceof AppError ? error : classifyGitHubError(error);
            lastError = classified;
            if (classified.code !== "inaccessible") allInaccessible = false;
            failures.push(`${path}@${ref.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          }
        };
        for (let pass = 0; pass < 2; pass++) {
          for (const path of pathCandidates) {
            for (const ref of refs) {
              const content = await tryRead(path, ref);
              if (content !== undefined) {
                return {
                  state: "available",
                  evidenceTrust: "untrusted",
                  path,
                  revision: ref,
                  content: redactSensitiveText(content),
                };
              }
            }
          }
          // Second pass: the run's path may differ from the current inventory path (renamed/moved file).
          const fromInventory = await resolveInventoryPath();
          if (!fromInventory || pathCandidates.includes(fromInventory)) break;
          pathCandidates.splice(0, pathCandidates.length, fromInventory);
        }
        // Every read was "inaccessible" with a token lacking private-repo scope: rethrow so
        // withPrivateRepositoryEscalation can request broader access and retry.
        if (lastError && allInaccessible && !hasPrivateRepositoryAccess(active)) throw lastError;
        return {
          state: "unavailable",
          reason: `Workflow source could not be read (${failures.slice(0, 3).join("; ")}).`,
        };
      },
      signal,
    );
  });

  register("actiondeck_inspect_dispatch_inputs", async (input: {
    repositoryId: string;
    workflowId: number;
    ref: string;
    inputs?: Record<string, string>;
  }, signal) => {
    const { repoContext, session, scheduler } = await requireActiveRepository(provider, input.repositoryId);
    const target = await withPrivateRepositoryEscalation(
      session,
      (active) => new DispatchRepository(scheduler, repoContext, active.accessToken).loadTarget(
        input.workflowId,
        input.ref,
        signal,
      ),
      signal,
    );
    if (target.state !== "available") {
      return {
        target,
        validation: { valid: false, values: {}, errors: { _form: target.reason } },
      };
    }
    return {
      target,
      validation: validateRemoteDispatchInputs(target, input.inputs ?? {}),
    };
  });

  const planStore = new PlanStore({
    get: <T>(key: string) => context.workspaceState.get<T>(key),
    update: (key: string, value: unknown) => Promise.resolve(context.workspaceState.update(key, value)),
  });

  register("actiondeck_inspect_plan", async (input: { repositoryId: string; planId: string }) => {
    const repoContext = provider.getActiveContext();
    if (!repoContext || repoContext.id !== input.repositoryId) {
      throw new AppError("invalid_input", "The requested repositoryId does not match the active repository.");
    }
    const plan = planStore.get(repoContext.id, input.planId);
    if (!plan) return { state: "not_found", planId: input.planId };
    return {
      id: plan.id,
      name: plan.name,
      state: plan.state,
      currentStepIndex: plan.currentStepIndex,
      ...(plan.blockedReason ? { blockedReason: plan.blockedReason } : {}),
      steps: plan.steps.map((s) => ({
        id: s.id,
        workflowPath: s.workflowPath,
        ref: s.ref,
        gate: s.gate,
        state: s.state,
        ...(s.error ? { error: s.error } : {}),
      })),
    };
  });

  register("actiondeck_inspect_pending_actions", async (input: { repositoryId: string }, signal) => {
    const repoContext = provider.getActiveContext();
    if (!repoContext || repoContext.id !== input.repositoryId) {
      throw new AppError("invalid_input", "The requested repositoryId does not match the active repository.");
    }
    const plans = planStore.list(repoContext.id).filter((p) =>
      p.state === "waiting_approval" || p.state === "blocked_uncertain" || p.state === "missed_schedule",
    );
    const session = await getGitHubSession(false);
    let pendingApprovalsState: "available" | "authentication_required" | "unavailable" = "available";
    let pendingApprovals: Awaited<ReturnType<typeof listPendingDeploymentSummaries>> = [];
    if (!session) {
      pendingApprovalsState = "authentication_required";
    } else {
      try {
        const scheduler = provider.getScheduler();
        pendingApprovals = await withPrivateRepositoryEscalation(
          session,
          (active) => {
            const runRepo = new RunRepository(scheduler, repoContext, active.accessToken);
            const deploymentRepo = new DeploymentRepository(scheduler, repoContext, active.accessToken);
            return listPendingDeploymentSummaries(runRepo, deploymentRepo, signal);
          },
          signal,
        );
      } catch {
        pendingApprovalsState = "unavailable";
      }
    }
    return {
      repositoryId: repoContext.id,
      blockedPlans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        ...(p.blockedReason ? { blockedReason: p.blockedReason } : {}),
      })),
      pendingApprovalsState,
      pendingApprovals: pendingApprovals.map((item) => ({
        runId: item.runId,
        ...(item.workflowId !== undefined ? { workflowId: item.workflowId } : {}),
        displayTitle: item.displayTitle,
        branch: item.branch,
        htmlUrl: item.htmlUrl,
        environments: item.environments.map((env) => ({
          environmentId: env.environmentId,
          environmentName: env.environmentName,
          eligible: env.eligible,
          currentUserCanApprove: env.currentUserCanApprove,
          waitTimerRemainingSeconds: env.waitTimerRemainingSeconds,
          ...(env.reason ? { reason: env.reason } : {}),
        })),
      })),
    };
  });
}

async function requireActiveRepository(
  provider: ReadToolContextProvider,
  repositoryId: string,
): Promise<{ repoContext: RepositoryContext; session: vscode.AuthenticationSession; scheduler: RepositoryScheduler }> {
  const repoContext = provider.getActiveContext();
  if (!repoContext || repoContext.id !== repositoryId) {
    throw new AppError(
      "invalid_input",
      "The requested repositoryId does not match the currently selected ActionDeck repository.",
    );
  }
  const session = await getGitHubSession(false);
  if (!session) {
    throw new AppError("authentication_required", "GitHub authentication is required.");
  }
  return {
    repoContext,
    session,
    scheduler: provider.getScheduler(),
  };
}
