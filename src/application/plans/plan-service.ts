import type { RepositoryContext } from "../../domain/models/repository";
import type { ReleasePlan, ReleasePlanStep } from "../../domain/models/release-plan";
import { AppError } from "../../domain/models/errors";
import { canAdvanceAfterStep } from "../../domain/services/plan-transitions";
import { PlanStore } from "../../persistence/plan-store";
import { UiAuthorization } from "../dispatch/authorization";
import {
  checkDispatchAssociation,
  executeDispatch,
  type DispatchSubmissionRepository,
} from "../dispatch/dispatch-service";

type RuntimeInputs = Readonly<Record<string, Readonly<Record<string, string>>>>;

const TERMINAL_PLAN_STATES: ReadonlySet<ReleasePlan["state"]> = new Set(["completed", "stopped"]);

export class ReleasePlanService {
  private readonly pausedByIdentityChange = new Set<string>();
  // Sensitive runtime inputs live only in Extension Host memory; the persisted plan stays sanitized.
  private readonly transientInputs = new Map<string, RuntimeInputs>();

  constructor(
    private readonly store: PlanStore,
    private readonly onPlanUpdated?: (plan: ReleasePlan) => void,
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
    runtimeInputs?: Readonly<Record<string, Readonly<Record<string, string>>>>,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const existing = this.store.get(context.id, planId);
    if (!existing) throw new AppError("not_found", "Release plan was not found.");
    if (existing.repositoryId !== context.id) {
      throw new AppError("stale", "Release plan belongs to a different repository context.");
    }
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
      ...existing,
      state: "running",
      steps: hydratedSteps,
      currentStepIndex: 0,
    });

    return this.executeCurrentStep(repository, context, plan, runtimeInputs, signal);
  }

  async pausePlan(repositoryId: string, planId: string): Promise<ReleasePlan> {
    const plan = this.store.get(repositoryId, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    return this.savePlan({ ...plan, state: "paused" });
  }

  async resumePlan(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    planId: string,
    runtimeInputs?: Readonly<Record<string, Readonly<Record<string, string>>>>,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const plan = this.store.get(context.id, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    if (plan.state !== "paused" && plan.state !== "missed_schedule") {
      throw new AppError("stale", "Only a paused or missed-schedule plan can be resumed.");
    }
    this.pausedByIdentityChange.delete(planId);
    this.retainRuntimeInputs(planId, runtimeInputs);
    const updated = await this.savePlan({ ...plan, state: "running" });
    return this.executeCurrentStep(repository, context, updated, runtimeInputs, signal);
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
    return this.savePlan({ ...plan, state: "stopped", steps });
  }

  haltOnIdentityChange(repositoryId: string): void {
    for (const plan of this.store.list(repositoryId)) {
      this.transientInputs.delete(plan.id);
      if (plan.state === "running" || plan.state === "scheduled") {
        this.pausedByIdentityChange.add(plan.id);
        void this.savePlan({
          ...plan,
          state: "paused",
          blockedReason: "Paused because GitHub identity or repository selection changed.",
        });
      }
    }
  }

  async markStepOutcomeUncertain(
    repositoryId: string,
    planId: string,
    reason: "not_observed" | "ambiguous" | "unavailable",
  ): Promise<ReleasePlan> {
    const plan = this.store.get(repositoryId, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    const current = plan.steps[plan.currentStepIndex];
    if (!current) return plan;
    return this.savePlan({
      ...plan,
      state: "blocked_uncertain",
      blockedReason: `Step ${current.workflowPath} outcome is uncertain (${reason}).`,
      steps: plan.steps.map((s, idx) =>
        idx === plan.currentStepIndex ? { ...s, state: "outcome_uncertain", error: reason } : s,
      ),
    });
  }

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
    },
    runtimeInputs?: Readonly<Record<string, Readonly<Record<string, string>>>>,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    const plan = this.store.get(context.id, planId);
    if (!plan) throw new AppError("not_found", "Release plan was not found.");
    if (plan.state === "paused" || plan.state === "stopped" || this.pausedByIdentityChange.has(plan.id)) {
      return plan;
    }

    const current = plan.steps[plan.currentStepIndex];
    if (!current) return plan;

    if (observed.waitingApproval) {
      const waitingStep: ReleasePlanStep = {
        ...current,
        state: "waiting_approval",
        runId: observed.runId,
        ...(observed.htmlUrl ? { htmlUrl: observed.htmlUrl } : {}),
      };
      return this.savePlan({
        ...plan,
        state: "waiting_approval",
        steps: plan.steps.map((s, idx) => (idx === plan.currentStepIndex ? waitingStep : s)),
      });
    }

    if (observed.status !== "completed") {
      const runningStep: ReleasePlanStep = {
        ...current,
        state: "running",
        runId: observed.runId,
        ...(observed.htmlUrl ? { htmlUrl: observed.htmlUrl } : {}),
      };
      return this.savePlan({
        ...plan,
        state: "running",
        steps: plan.steps.map((s, idx) => (idx === plan.currentStepIndex ? runningStep : s)),
      });
    }

    const decision = canAdvanceAfterStep(current.gate, observed.conclusion);
    const completedStep: ReleasePlanStep = {
      ...current,
      state: decision === "advance" ? "completed" : "failed",
      runId: observed.runId,
      conclusion: observed.conclusion,
      ...(observed.htmlUrl ? { htmlUrl: observed.htmlUrl } : {}),
    };
    const nextSteps = plan.steps.map((s, idx) => (idx === plan.currentStepIndex ? completedStep : s));
    if (decision === "stop") {
      return this.savePlan({
        ...plan,
        state: "stopped",
        steps: nextSteps,
        blockedReason: `Stopped at step ${current.workflowPath} (${observed.conclusion ?? "non-success"}).`,
      });
    }

    const nextIndex = plan.currentStepIndex + 1;
    if (nextIndex >= nextSteps.length) {
      return this.savePlan({ ...plan, state: "completed", steps: nextSteps });
    }

    const advanced = await this.savePlan({
      ...plan,
      state: "running",
      steps: nextSteps,
      currentStepIndex: nextIndex,
    });
    return this.executeCurrentStep(repository, context, advanced, runtimeInputs, signal);
  }

  private async executeCurrentStep(
    repository: DispatchSubmissionRepository,
    context: RepositoryContext,
    plan: ReleasePlan,
    runtimeInputs?: Readonly<Record<string, Readonly<Record<string, string>>>>,
    signal?: AbortSignal,
  ): Promise<ReleasePlan> {
    if (plan.state !== "running" || this.pausedByIdentityChange.has(plan.id)) return plan;
    const step = plan.steps[plan.currentStepIndex];
    if (!step) return this.savePlan({ ...plan, state: "completed" });

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
    const checkpointed = await this.savePlan({
      ...plan,
      steps: plan.steps.map((s, idx) =>
        idx === plan.currentStepIndex
          ? { ...s, state: "dispatching", submittedAt }
          : s,
      ),
    });

    const auth = new UiAuthorization();
    auth.authorize({
      repositoryId: context.id,
      target: `workflow:${step.workflowId}`,
      ref: step.ref,
      inputs: effectiveInputs,
    });

    const result = await executeDispatch(
      repository,
      context,
      auth,
      { workflowId: step.workflowId, ref: step.ref, inputs: effectiveInputs },
      undefined,
      signal,
    );

    if (result.state === "outcome_uncertain") {
      return this.savePlan({
        ...checkpointed,
        state: "blocked_uncertain",
        blockedReason: `Step ${step.workflowPath} outcome is uncertain (${result.reconciliation}).`,
        steps: checkpointed.steps.map((s, idx) =>
          idx === checkpointed.currentStepIndex
            ? { ...s, state: "outcome_uncertain", error: result.reconciliation }
            : s,
        ),
      });
    }

    if (result.state === "completed") {
      return this.advanceOnRunObserved(
        repository,
        context,
        checkpointed.id,
        { runId: result.runId, status: "completed", conclusion: result.conclusion, htmlUrl: result.htmlUrl },
        runtimeInputs,
        signal,
      );
    }

    if (result.state === "associated_run_found") {
      return this.savePlan({
        ...checkpointed,
        steps: checkpointed.steps.map((s, idx) =>
          idx === checkpointed.currentStepIndex
            ? { ...s, state: "running", runId: result.runId, htmlUrl: result.htmlUrl }
            : s,
        ),
      });
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
    return this.savePlan({
      ...checkpointed,
      steps: checkpointed.steps.map((s, idx) =>
        idx === checkpointed.currentStepIndex
          ? {
            ...s,
            state: rechecked.state === "associated_run_found" ? "running" : "request_accepted",
            acceptedAt: result.acceptedAt,
            ...(rechecked.state === "associated_run_found"
              ? { runId: rechecked.runId, htmlUrl: rechecked.htmlUrl }
              : {}),
          }
          : s,
      ),
    });
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
