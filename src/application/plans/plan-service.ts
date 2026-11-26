import type { RepositoryContext } from "../../domain/models/repository";
import type { ReleasePlan, ReleasePlanStep } from "../../domain/models/release-plan";
import { AppError } from "../../domain/models/errors";
import {
  ACTIVE_STEP_STATES,
  canAdvanceAfterStep,
  failedReason,
  stageAt,
  stageOutcome,
  uncertainReason,
} from "../../domain/services/plan-transitions";
import { PlanStore } from "../../persistence/plan-store";
import { UiAuthorization } from "../dispatch/authorization";
import {
  checkDispatchAssociation,
  executeDispatch,
  type DispatchSubmissionRepository,
} from "../dispatch/dispatch-service";

type RuntimeInputs = Readonly<Record<string, Readonly<Record<string, string>>>>;

const TERMINAL_PLAN_STATES: ReadonlySet<ReleasePlan["state"]> = new Set(["completed", "stopped"]);
/** Step states a retry dispatches again. */
const RETRYABLE_STEP_STATES: ReadonlySet<ReleasePlanStep["state"]> = new Set(["failed", "outcome_uncertain", "stopped"]);

export interface PlanClock {
  now(): number;
}

/** A plan without its hold and blocked reason, for moving it back to running. */
function withoutHold(plan: ReleasePlan): ReleasePlan {
  const { hold: _hold, blockedReason: _reason, ...rest } = plan;
  return rest;
}

/** A step ready to be dispatched again, with everything from its previous attempt removed. */
function resetStep(step: ReleasePlanStep): ReleasePlanStep {
  const {
    runId: _runId,
    conclusion: _conclusion,
    htmlUrl: _htmlUrl,
    submittedAt: _submittedAt,
    acceptedAt: _acceptedAt,
    error: _error,
    ...rest
  } = step;
  return { ...rest, state: "pending" };
}

/** The step after it finished, marked completed or failed by its own gate. */
function finishedStep(
  step: ReleasePlanStep,
  observed: { runId: number; conclusion: string | null; htmlUrl?: string },
): ReleasePlanStep {
  return {
    ...step,
    state: canAdvanceAfterStep(step.gate, observed.conclusion) === "advance" ? "completed" : "failed",
    runId: observed.runId,
    conclusion: observed.conclusion,
    ...(observed.htmlUrl ? { htmlUrl: observed.htmlUrl } : {}),
  };
}

export class ReleasePlanService {
  private readonly pausedByIdentityChange = new Set<string>();
  // Sensitive runtime inputs live only in Extension Host memory; the persisted plan stays sanitized.
  private readonly transientInputs = new Map<string, RuntimeInputs>();

  constructor(
    private readonly store: PlanStore,
    private readonly onPlanUpdated?: (plan: ReleasePlan) => void,
    private readonly clock: PlanClock = { now: () => Date.now() },
  ) {}

  async savePlan(plan: ReleasePlan): Promise<ReleasePlan> {
    const saved = await this.store.save({ ...plan, updatedAt: Date.now() });
    if (TERMINAL_PLAN_STATES.has(saved.state)) this.transientInputs.delete(saved.id);
    this.onPlanUpdated?.(saved);
    return saved;
  }

  async startPlan(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    planId: string,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const existing = this.requirePlan(context, planId);
    this.pausedByIdentityChange.delete(planId);
    this.retainRuntimeInputs(planId, runtimeInputs);

    const hydratedSteps = existing.steps.map((step) => {
      const provided = runtimeInputs?.[step.id] ?? {};
      const merged = { ...step.inputs, ...provided };
      const missingSensitive = (step.reEntryRequiredKeys ?? []).filter(
        (key) => !(merged[key] && merged[key].length > 0),
      );
      if (missingSensitive.length > 0) {
        throw new AppError(
          "invalid_input",
          `Sensitive inputs must be re-entered before starting: ${missingSensitive.join(", ")}.`,
        );
      }
      return { ...step, inputs: merged, reEntryRequiredKeys: [] };
    });

    const plan = await this.savePlan({
      ...withoutHold(existing),
      state: "running",
      steps: hydratedSteps,
      currentStepIndex: 0,
    });
    // The first stage never waits: the plan's own schedule decides when it starts.
    return this.runStage(repository, context, plan, runtimeInputs, signal);
  }

  async pausePlan(repositoryId: string, planId: string): Promise<ReleasePlan> {
    const plan = this.store.get(repositoryId, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    return this.savePlan({ ...withoutHold(plan), state: "paused" });
  }

  async resumePlan(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    planId: string,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const plan = this.requirePlan(context, planId);
    if (plan.state !== "paused" && plan.state !== "missed_schedule") {
      throw new AppError("stale", "Only a paused or missed-schedule plan can be resumed.");
    }
    this.pausedByIdentityChange.delete(planId);
    this.retainRuntimeInputs(planId, runtimeInputs);
    const updated = await this.savePlan({ ...withoutHold(plan), state: "running" });
    return this.runStage(repository, context, updated, runtimeInputs, signal);
  }

  /**
   * Moves an `on_hold` plan on. The user continuing skips any remaining wait; the wait timer elapsing
   * moves on to the confirmation when the stage also asks for one.
   */
  async continuePlan(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    planId: string,
    source: "user" | "timer",
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const plan = this.requirePlan(context, planId);
    if (plan.state !== "on_hold") {
      if (source === "timer") return plan;
      throw new AppError("stale", "This plan is not waiting to continue.");
    }
    const first = plan.steps[plan.currentStepIndex];
    if (source === "timer" && plan.hold?.kind === "wait" && first?.confirmBefore) {
      return this.savePlan({ ...withoutHold(plan), state: "on_hold", hold: { kind: "confirm" } });
    }
    this.retainRuntimeInputs(planId, runtimeInputs);
    const running = await this.savePlan({ ...withoutHold(plan), state: "running" });
    return this.runStage(repository, context, running, runtimeInputs, signal);
  }

  /**
   * Dispatches the current stage's failed, uncertain or stopped steps again and continues the plan.
   * Steps of later stages that a stop skipped run again as well.
   */
  async retryPlan(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    planId: string,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const plan = this.requirePlan(context, planId);
    if (plan.state !== "stopped" && plan.state !== "blocked_uncertain") {
      throw new AppError("stale", "Only a stopped or blocked plan can be retried.");
    }
    const stage = stageAt(plan.steps, plan.currentStepIndex);
    if (!stage) throw new AppError("stale", "This plan has no step left to retry.");
    const steps = plan.steps.map((step, index) => {
      if (index >= stage.start && index < stage.end && RETRYABLE_STEP_STATES.has(step.state)) return resetStep(step);
      if (index >= stage.end && step.state === "stopped") return resetStep(step);
      return step;
    });
    if (steps.every((step, index) => step === plan.steps[index])) {
      throw new AppError("stale", "This plan has no failed or stopped step to retry.");
    }
    this.pausedByIdentityChange.delete(planId);
    this.retainRuntimeInputs(planId, runtimeInputs);
    const running = await this.savePlan({ ...withoutHold(plan), state: "running", steps });
    return this.runStage(repository, context, running, runtimeInputs, signal);
  }

  async stopPlan(repositoryId: string, planId: string): Promise<ReleasePlan> {
    // Stop prevents future dispatches but never cancels an already-running GitHub run.
    const plan = this.store.get(repositoryId, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    this.transientInputs.delete(planId);
    const steps = plan.steps.map((step, index) =>
      index >= plan.currentStepIndex && step.state === "pending"
        ? { ...step, state: "stopped" as const }
        : step,
    );
    const { hold: _hold, ...rest } = plan;
    return this.savePlan({ ...rest, state: "stopped", steps });
  }

  haltOnIdentityChange(repositoryId: string): void {
    for (const plan of this.store.list(repositoryId)) {
      this.transientInputs.delete(plan.id);
      if (plan.state === "running" || plan.state === "scheduled" || plan.state === "on_hold") {
        this.pausedByIdentityChange.add(plan.id);
        void this.savePlan({
          ...withoutHold(plan),
          state: "paused",
          blockedReason: "Paused because the GitHub account changed.",
        });
      }
    }
  }

  /** Marks a dispatched step whose run could not be found, then settles its stage. */
  async markStepOutcomeUncertain(
    repositoryId: string,
    planId: string,
    reason: "not_observed" | "ambiguous" | "unavailable",
    stepId?: string,
  ): Promise<ReleasePlan> {
    const plan = this.store.get(repositoryId, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    const index = this.findStageStep(plan, stepId);
    if (index === undefined) return plan;
    const steps = plan.steps.map((step, idx) =>
      idx === index ? { ...step, state: "outcome_uncertain" as const, error: reason } : step,
    );
    const updated = { ...plan, steps };
    const stage = stageAt(steps, plan.currentStepIndex);
    const outcome = stage ? stageOutcome(steps, stage) : undefined;
    if (outcome?.kind === "uncertain") {
      return this.savePlan({ ...updated, state: "blocked_uncertain", blockedReason: uncertainReason(outcome.steps) });
    }
    return this.savePlan(updated);
  }

  /** Records what GitHub reports for a step's run, then moves the plan on when its stage has finished. */
  async advanceOnRunObserved(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    planId: string,
    observed: {
      runId: number;
      status: string;
      conclusion: string | null;
      waitingApproval?: boolean;
      htmlUrl?: string;
      stepId?: string;
    },
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const plan = this.requirePlan(context, planId);
    if (plan.state !== "running" && plan.state !== "waiting_approval") return plan;
    if (this.pausedByIdentityChange.has(plan.id)) return plan;

    const index = observed.stepId !== undefined
      ? this.findStageStep(plan, observed.stepId)
      : this.findStageStep(plan, undefined, observed.runId);
    const current = index === undefined ? undefined : plan.steps[index];
    if (index === undefined || !current) return plan;

    const updatedStep: ReleasePlanStep = observed.waitingApproval
      ? { ...current, state: "waiting_approval", runId: observed.runId, ...(observed.htmlUrl ? { htmlUrl: observed.htmlUrl } : {}) }
      : observed.status !== "completed"
        ? { ...current, state: "running", runId: observed.runId, ...(observed.htmlUrl ? { htmlUrl: observed.htmlUrl } : {}) }
        : finishedStep(current, observed);
    const saved = await this.savePlan({
      ...plan,
      steps: plan.steps.map((step, idx) => (idx === index ? updatedStep : step)),
    });
    return this.settleStage(repository, context, saved, runtimeInputs, signal);
  }

  /**
   * Re-evaluates the current stage: keeps a running stage running, stops or blocks the plan when a step
   * did not pass, and moves on to the next stage once every step has.
   */
  async settleStage(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    plan: ReleasePlan,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    if (plan.state !== "running" && plan.state !== "waiting_approval") return plan;
    if (this.pausedByIdentityChange.has(plan.id)) return plan;
    const stage = stageAt(plan.steps, plan.currentStepIndex);
    if (!stage) return this.savePlan({ ...withoutHold(plan), state: "completed" });

    const outcome = stageOutcome(plan.steps, stage);
    switch (outcome.kind) {
      case "active": {
        const state = outcome.waitingApproval ? "waiting_approval" : "running";
        return state === plan.state ? plan : this.savePlan({ ...plan, state });
      }
      case "uncertain":
        return this.savePlan({ ...plan, state: "blocked_uncertain", blockedReason: uncertainReason(outcome.steps) });
      case "failed":
        return this.savePlan({ ...plan, state: "stopped", blockedReason: failedReason(outcome.steps) });
      case "stopped":
        return this.savePlan({ ...plan, state: "stopped" });
      case "pending":
        return plan;
      case "succeeded": {
        if (stage.end >= plan.steps.length) return this.savePlan({ ...withoutHold(plan), state: "completed" });
        return this.enterStage(repository, context, { ...plan, currentStepIndex: stage.end }, runtimeInputs, signal);
      }
    }
  }

  /** Starts the stage at `currentStepIndex`, first holding for its wait or confirmation if it asks for one. */
  private async enterStage(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    plan: ReleasePlan,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const first = plan.steps[plan.currentStepIndex];
    const waitMinutes = first?.waitBeforeMinutes ?? 0;
    if (waitMinutes > 0) {
      return this.savePlan({
        ...withoutHold(plan),
        state: "on_hold",
        hold: { kind: "wait", untilMs: this.clock.now() + waitMinutes * 60_000 },
      });
    }
    if (first?.confirmBefore) {
      return this.savePlan({ ...withoutHold(plan), state: "on_hold", hold: { kind: "confirm" } });
    }
    const running = await this.savePlan({ ...withoutHold(plan), state: "running" });
    return this.runStage(repository, context, running, runtimeInputs, signal);
  }

  /** Dispatches every pending step of the current stage, one after another, then settles the stage. */
  private async runStage(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    plan: ReleasePlan,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    if (plan.state !== "running" || this.pausedByIdentityChange.has(plan.id)) return plan;
    const stage = stageAt(plan.steps, plan.currentStepIndex);
    if (!stage) return this.savePlan({ ...withoutHold(plan), state: "completed" });

    let current = plan;
    for (let index = stage.start; index < stage.end; index++) {
      if (current.steps[index]?.state !== "pending") continue;
      current = await this.dispatchStep(repository, context, current, index, runtimeInputs, signal);
      if (current.state !== "running") return current;
    }
    return this.settleStage(repository, context, current, runtimeInputs, signal);
  }

  /** Dispatches one step and records its state; never moves the plan to another stage. */
  private async dispatchStep(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    plan: ReleasePlan,
    index: number,
    runtimeInputs?: RuntimeInputs,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const step = plan.steps[index];
    if (!step) return plan;
    const patchStep = (base: ReleasePlan, patch: Partial<ReleasePlanStep>): ReleasePlan => ({
      ...base,
      steps: base.steps.map((s, idx) => (idx === index ? { ...s, ...patch } : s)),
    });

    const effectiveInputs = {
      ...step.inputs,
      ...(this.transientInputs.get(plan.id)?.[step.id] ?? {}),
      ...(runtimeInputs?.[step.id] ?? {}),
    };
    const missingSensitive = (step.reEntryRequiredKeys ?? []).filter(
      (key) => !(effectiveInputs[key] && effectiveInputs[key].length > 0),
    );
    if (missingSensitive.length > 0) {
      return this.savePlan({
        ...plan,
        state: "paused",
        blockedReason: `Re-enter sensitive inputs for ${step.workflowPath} to continue: ${missingSensitive.join(", ")}.`,
      });
    }
    const submittedAt = Date.now();
    // Pre-submission checkpoint persisted before transmission so reload never re-dispatches automatically.
    const checkpointed = await this.savePlan(patchStep(plan, { state: "dispatching", submittedAt }));

    const auth = new UiAuthorization();
    auth.authorize({
      repositoryId: context.id,
      target: `workflow:${step.workflowId}`,
      ref: step.ref,
      inputs: effectiveInputs,
    });

    let result: Awaited<ReturnType<typeof executeDispatch>>;
    try {
      result = await executeDispatch(
        repository,
        context,
        auth,
        { workflowId: step.workflowId, ref: step.ref, inputs: effectiveInputs },
        undefined,
        signal,
      );
    } catch (error) {
      // executeDispatch reconciles network failures itself; anything it throws was never dispatched.
      const message = error instanceof Error ? error.message : String(error);
      return this.savePlan(patchStep(checkpointed, { state: "failed", error: `Not dispatched: ${message}` }));
    }

    if (result.state === "outcome_uncertain") {
      return this.savePlan(patchStep(checkpointed, { state: "outcome_uncertain", error: result.reconciliation }));
    }
    if (result.state === "completed") {
      return this.savePlan(patchStep(checkpointed, finishedStep(step, result)));
    }
    if (result.state === "associated_run_found") {
      return this.savePlan(patchStep(checkpointed, { state: "running", runId: result.runId, htmlUrl: result.htmlUrl }));
    }

    const rechecked = await checkDispatchAssociation(
      repository,
      context,
      {
        workflowId: step.workflowId,
        ref: step.ref,
        submittedAt: result.submittedAt,
        acceptedAt: result.acceptedAt,
      },
      signal,
    );
    return this.savePlan(patchStep(checkpointed, {
      state: rechecked.state === "associated_run_found" ? "running" : "request_accepted",
      acceptedAt: result.acceptedAt,
      ...(rechecked.state === "associated_run_found"
        ? { runId: rechecked.runId, htmlUrl: rechecked.htmlUrl }
        : {}),
    }));
  }

  /**
   * Index of a step in the current stage: by id, by run id, or else the first dispatched one still active.
   */
  private findStageStep(plan: ReleasePlan, stepId?: string, runId?: number): number | undefined {
    const stage = stageAt(plan.steps, plan.currentStepIndex);
    if (!stage) return undefined;
    for (let index = stage.start; index < stage.end; index++) {
      const step = plan.steps[index]!;
      if (stepId !== undefined ? step.id === stepId : runId !== undefined && step.runId === runId) return index;
    }
    if (stepId !== undefined) return undefined;
    for (let index = stage.start; index < stage.end; index++) {
      if (ACTIVE_STEP_STATES.has(plan.steps[index]!.state)) return index;
    }
    // A stage of one step can only mean that step.
    return stage.end - stage.start === 1 ? stage.start : undefined;
  }

  private requirePlan(context: RepositoryContext, planId: string): ReleasePlan {
    const plan = this.store.get(context.id, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    if (plan.repositoryId !== context.id) {
      throw new AppError("stale", "Release plan belongs to a different repository context.");
    }
    return plan;
  }

  private retainRuntimeInputs(planId: string, runtimeInputs: RuntimeInputs | undefined): void {
    if (!runtimeInputs) return;
    const merged: Record<string, Readonly<Record<string, string>>> = { ...(this.transientInputs.get(planId) ?? {}) };
    for (const [stepId, inputs] of Object.entries(runtimeInputs)) {
      merged[stepId] = { ...(merged[stepId] ?? {}), ...inputs };
    }
    this.transientInputs.set(planId, merged);
  }
}
