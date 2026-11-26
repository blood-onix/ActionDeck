import type { DispatchTarget } from "../../domain/models/dispatch";
import type { PendingEnvironment } from "../../domain/models/approval";
import type { ReleasePlan } from "../../domain/models/release-plan";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import { isSensitiveInputName } from "../../domain/services/plan-transitions";
import { validateRemoteDispatchInputs } from "../dispatch/dispatch-validation";
import type { ReviewedAction } from "../dispatch/authorization";
import type { RunResponse } from "../runs/inspection-service";
import type { CopilotExecutionProposal } from "./execution-tools";

/** A target that was validated against remote state, with the exact values the user will confirm. */
export interface ResolvedCopilotAction {
  readonly proposal: CopilotExecutionProposal;
  readonly reviewed: ReviewedAction;
}

export interface DispatchTargetPort {
  loadTarget(workflowId: number, ref: string, signal?: AbortSignal): Promise<DispatchTarget>;
}

export interface RunStatePort {
  getRun(runId: number, signal?: AbortSignal): Promise<RunResponse>;
}

export interface PendingDeploymentPort {
  listPendingDeployments(runId: number, signal?: AbortSignal): Promise<PendingEnvironment[]>;
}

export interface PlanLookupPort {
  get(repositoryId: string, planId: string): ReleasePlan | undefined;
}

const STARTABLE_PLAN_STATES: ReadonlySet<ReleasePlan["state"]> = new Set(["draft", "scheduled"]);
const RERUNNABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);
const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set(["queued", "in_progress", "waiting", "pending"]);

export async function resolveDispatchAction(
  context: RepositoryContext,
  port: DispatchTargetPort,
  request: {
    readonly workflowId: number;
    readonly ref: string;
    readonly inputs: Readonly<Record<string, string>>;
  },
  signal?: AbortSignal,
): Promise<ResolvedCopilotAction> {
  const target = await port.loadTarget(request.workflowId, request.ref, signal);
  if (target.state !== "available") {
    throw new AppError("invalid_input", target.reason);
  }
  const validation = validateRemoteDispatchInputs(target, request.inputs);
  if (!validation.valid) {
    const messages = Object.values(validation.errors).join(" ");
    throw new AppError("invalid_input", `Dispatch inputs are invalid for the remote workflow definition: ${messages}`);
  }
  return {
    proposal: {
      action: "dispatch_workflow",
      repositoryId: context.id,
      targetLabel: `${target.workflowPath} (workflow ${target.workflowId})`,
      refOrEnvironment: request.ref,
      effectiveParameters: { ...validation.values },
    },
    reviewed: {
      repositoryId: context.id,
      target: `workflow:${request.workflowId}`,
      ref: request.ref,
      inputs: { ...validation.values },
    },
  };
}

export async function resolveRunAction(
  context: RepositoryContext,
  port: RunStatePort,
  request: {
    readonly action: "cancel" | "rerun_failed_jobs" | "rerun_all";
    readonly runId: number;
    readonly attempt: number;
  },
  signal?: AbortSignal,
): Promise<ResolvedCopilotAction> {
  const run = await port.getRun(request.runId, signal);
  if (run.id !== request.runId || (run.run_attempt ?? 1) !== request.attempt) {
    throw new AppError("stale", "The requested run attempt does not match the current remote run. Inspect the run again.");
  }
  const status = run.status ?? "unknown";
  if (request.action === "cancel" && !CANCELLABLE_STATUSES.has(status)) {
    throw new AppError("invalid_input", `A run with status "${status}" cannot be cancelled.`);
  }
  if (
    request.action === "rerun_failed_jobs" &&
    (status !== "completed" || !RERUNNABLE_CONCLUSIONS.has(run.conclusion ?? ""))
  ) {
    throw new AppError("invalid_input", "Failed jobs can be rerun only for a completed run that failed, timed out, or failed to start.");
  }
  if (request.action === "rerun_all" && status !== "completed") {
    throw new AppError("invalid_input", "All jobs can be rerun only after the run completes.");
  }
  return {
    proposal: {
      action: "run_action",
      repositoryId: context.id,
      targetLabel: `run:${run.id}:attempt:${request.attempt} "${run.display_title}"`,
      refOrEnvironment: request.action,
      effectiveParameters: {
        action: request.action,
        runId: String(request.runId),
        attempt: String(request.attempt),
        runStatus: status,
        ...(run.head_branch ? { branch: run.head_branch } : {}),
      },
    },
    reviewed: {
      repositoryId: context.id,
      target: `${request.action}:run:${request.runId}:attempt:${request.attempt}`,
      ref: "",
      inputs: {},
    },
  };
}

export async function resolveDeploymentReview(
  context: RepositoryContext,
  runPort: RunStatePort,
  deploymentPort: PendingDeploymentPort,
  request: {
    readonly runId: number;
    readonly environmentIds: readonly number[];
    readonly state: "approved" | "rejected";
    readonly comment?: string;
  },
  signal?: AbortSignal,
): Promise<ResolvedCopilotAction & { readonly environmentIds: readonly number[] }> {
  const run = await runPort.getRun(request.runId, signal);
  if (run.id !== request.runId || run.status !== "waiting") {
    throw new AppError("stale", "The run is not currently waiting for deployment review.");
  }
  const environmentIds = [...new Set(request.environmentIds)].sort((left, right) => left - right);
  const pending = await deploymentPort.listPendingDeployments(request.runId, signal);
  const selected: PendingEnvironment[] = [];
  for (const environmentId of environmentIds) {
    const environment = pending.find((candidate) => candidate.environmentId === environmentId);
    if (!environment) {
      throw new AppError("stale", `Environment ${environmentId} is not pending review for this run.`);
    }
    if (!environment.currentUserCanApprove) {
      throw new AppError("permission_restricted", `You are not an authorized reviewer for environment "${environment.environmentName}".`);
    }
    if (request.state === "approved" && !environment.eligible) {
      throw new AppError("invalid_input", `Environment "${environment.environmentName}" cannot be approved yet: ${environment.reason ?? "not eligible"}`);
    }
    selected.push(environment);
  }
  const comment = request.comment ?? "";
  return {
    environmentIds,
    proposal: {
      action: "review_deployment",
      repositoryId: context.id,
      targetLabel: `run:${run.id} "${run.display_title}" environments: ${
        selected.map((environment) => `${environment.environmentName} (#${environment.environmentId})`).join(", ")
      }`,
      refOrEnvironment: request.state,
      effectiveParameters: {
        comment,
        ...(run.head_branch ? { branch: run.head_branch } : {}),
      },
    },
    reviewed: {
      repositoryId: context.id,
      target: `review:run:${request.runId}:envs:${environmentIds.join(",")}`,
      ref: request.state,
      inputs: { comment },
    },
  };
}

function planSteps(plan: ReleasePlan): string[] {
  return plan.steps.map((step, index) => {
    const inputs = Object.entries(step.inputs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${isSensitiveInputName(name) || step.sensitiveInputKeys.includes(name) ? "[sensitive]" : value}`)
      .join(", ");
    return `${index + 1}. ${step.workflowPath}@${step.ref} [${step.gate}] ${inputs}`.trimEnd();
  });
}

function planFingerprint(plan: ReleasePlan): string {
  return JSON.stringify({
    state: plan.state,
    steps: plan.steps.map((step) => [
      step.workflowId,
      step.workflowPath,
      step.ref,
      step.gate,
      Object.entries(step.inputs).sort(([left], [right]) => left.localeCompare(right)),
    ]),
  });
}

export async function resolvePlanStart(
  context: RepositoryContext,
  plans: PlanLookupPort,
  port: DispatchTargetPort,
  planId: string,
  signal?: AbortSignal,
): Promise<ResolvedCopilotAction> {
  const plan = plans.get(context.id, planId);
  if (!plan || plan.repositoryId !== context.id) {
    throw new AppError("not_found", "Release plan was not found for the active repository.");
  }
  if (!STARTABLE_PLAN_STATES.has(plan.state)) {
    throw new AppError("invalid_input", `A release plan in state "${plan.state}" cannot be started from Copilot.`);
  }
  if (plan.steps.length === 0) {
    throw new AppError("invalid_input", "The release plan has no steps.");
  }
  const reEntry = plan.steps.flatMap((step) => step.reEntryRequiredKeys ?? []);
  if (reEntry.length > 0) {
    throw new AppError(
      "invalid_input",
      `Sensitive inputs must be re-entered in the ActionDeck dashboard before this plan can start: ${[...new Set(reEntry)].join(", ")}.`,
    );
  }
  for (const step of plan.steps) {
    const target = await port.loadTarget(step.workflowId, step.ref, signal);
    if (target.state !== "available") {
      throw new AppError("invalid_input", `Step ${step.workflowPath}@${step.ref} is blocked: ${target.reason}`);
    }
    const validation = validateRemoteDispatchInputs(target, step.inputs);
    if (!validation.valid) {
      const messages = Object.values(validation.errors).join(" ");
      throw new AppError("invalid_input", `Step ${step.workflowPath}@${step.ref} has invalid inputs: ${messages}`);
    }
  }
  const { effectiveParameters, reviewed } = reviewPlan(context, plan);
  return {
    proposal: {
      action: "start_plan",
      repositoryId: context.id,
      targetLabel: `plan:${plan.id} "${plan.name}"`,
      refOrEnvironment: "sequential",
      effectiveParameters,
    },
    reviewed,
  };
}

function reviewPlan(
  context: RepositoryContext,
  plan: ReleasePlan,
): { effectiveParameters: Record<string, string>; reviewed: ReviewedAction } {
  const effectiveParameters = {
    planId: plan.id,
    name: plan.name,
    stepCount: String(plan.steps.length),
    steps: planSteps(plan).join(" | "),
  };
  return {
    effectiveParameters,
    reviewed: {
      repositoryId: context.id,
      target: `plan:${plan.id}`,
      ref: "sequential",
      inputs: { revision: planFingerprint(plan), ...effectiveParameters },
    },
  };
}

/** Re-resolves the persisted plan so a plan edited after confirmation fails the exact-match authorization. */
export function currentPlanReview(
  context: RepositoryContext,
  plans: PlanLookupPort,
  planId: string,
): ReviewedAction {
  const plan = plans.get(context.id, planId);
  if (!plan) throw new AppError("not_found", "Release plan was not found for the active repository.");
  return reviewPlan(context, plan).reviewed;
}
