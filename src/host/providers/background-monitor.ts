import type { RepositoryContext } from "../../domain/models/repository";
import type { WorkflowRunRecord } from "../../domain/models/run";
import type { RunNotification } from "../../domain/models/notifications";
import type { PendingEnvironment, DeploymentReviewItemResult } from "../../domain/models/approval";
import type { RepositoryScheduler, SchedulerLease } from "../../github/rate-limit/repository-scheduler";
import { RunRepository } from "../../github/repositories/run-repository";
import { DispatchRepository } from "../../github/repositories/dispatch-repository";
import { DeploymentRepository } from "../../github/repositories/deployment-repository";
import type { DispatchSubmissionRepository } from "../../application/dispatch/dispatch-service";
import { UiAuthorization } from "../../application/dispatch/authorization";
import { reviewPendingDeployments, type DeploymentReviewPort } from "../../application/approvals/approval-service";
import type { AutoApprovalService } from "../../application/approvals/auto-approval-service";
import type { RunApprovalGrantService } from "../../application/approvals/run-approval-grants";
import { scopeCoversEnvironment } from "../../domain/services/auto-approval-scope";
import { isOriginalActor, type NotificationService } from "../../application/runs/notification-service";
import type { ReleasePlanService } from "../../application/plans/plan-service";
import { associateDispatchRun } from "../../application/dispatch/run-association";
import type { ReleasePlanStep } from "../../domain/models/release-plan";
import type { PlanStore } from "../../persistence/plan-store";
import type { PlanStatusBarTicker } from "./plan-status";

export interface AutoApprovalAuditEntry {
  readonly timestamp: number;
  readonly repositoryId: string;
  readonly runId: number;
  readonly workflowId: number;
  readonly environmentId: number;
  readonly environmentName: string;
  readonly ruleId: string;
  readonly status: DeploymentReviewItemResult["status"];
  readonly error?: string;
}

export interface ApprovalPrompt {
  readonly repositoryId: string;
  readonly runId: number;
  readonly workflowId: number;
  readonly title: string;
  readonly branch: string;
  readonly environmentId: number;
  readonly environmentName: string;
}

export interface BackgroundMonitorPorts {
  readonly loadRecentRuns?: (signal: AbortSignal) => Promise<{ runs: WorkflowRunRecord[] }>;
  readonly createDispatchRepository?: () => DispatchSubmissionRepository;
  readonly createDeploymentRepository?: () => DeploymentReviewPort & {
    listPendingDeployments(runId: number, signal?: AbortSignal): Promise<PendingEnvironment[]>;
  };
  readonly notify?: (notification: RunNotification) => void | Promise<void>;
  readonly notifyApproval?: (prompt: ApprovalPrompt) => void | Promise<void>;
  readonly onRunsObserved?: (runs: readonly WorkflowRunRecord[]) => void;
  readonly onAutoApprovalAudit?: (entry: AutoApprovalAuditEntry) => void | Promise<void>;
}

export interface BackgroundMonitorOptions {
  readonly context: RepositoryContext;
  readonly authenticatedLogin: string;
  readonly token: string;
  readonly scheduler: RepositoryScheduler;
  readonly planStore: PlanStore;
  readonly planService: ReleasePlanService;
  readonly notificationService: NotificationService;
  readonly autoApprovalService: AutoApprovalService;
  readonly runApprovalGrants?: RunApprovalGrantService;
  readonly statusTicker: Pick<PlanStatusBarTicker, "update">;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly ports?: BackgroundMonitorPorts;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const ASSOCIATION_WINDOW_AFTER_ACCEPTANCE_MS = 120_000;
const MAX_WAITING_DEPLOYMENT_CHECKS = 10;

export class BackgroundMonitor {
  private readonly lease: SchedulerLease;
  private readonly pollIntervalMs: number;
  private token: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlightAbort: AbortController | undefined;
  private polling = false;
  private disposed = false;
  private isInitialHydration = true;
  private readonly autoApprovedKeys = new Set<string>();
  private readonly succeededAutoApprovals = new Set<string>();

  constructor(private readonly options: BackgroundMonitorOptions) {
    this.token = options.token;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.lease = options.scheduler.createLease(options.context.id, "background");
  }

  get repositoryId(): string {
    return this.options.context.id;
  }

  isActive(): boolean {
    return !this.disposed && this.lease.isActive();
  }

  updateToken(token: string): void {
    if (this.disposed) return;
    this.token = token;
  }

  start(): void {
    if (this.disposed || this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  async pollOnce(): Promise<void> {
    if (this.disposed || !this.lease.isActive() || this.polling) return;
    this.polling = true;
    const controller = new AbortController();
    this.inFlightAbort = controller;

    try {
      const runs = await this.loadRuns(controller.signal);
      if (this.disposed || !this.lease.isActive() || controller.signal.aborted) return;

      const wasInitialHydration = this.isInitialHydration;
      this.isInitialHydration = false;

      // 1. Notifications
      const notifications = this.options.notificationService.evaluate(
        this.options.context.id,
        this.options.authenticatedLogin,
        runs,
        wasInitialHydration,
        this.options.context.authenticatedUserId,
      );
      for (const notification of notifications) {
        if (this.disposed || !this.lease.isActive()) return;
        await this.options.ports?.notify?.(notification);
      }

      this.options.ports?.onRunsObserved?.(runs);

      // 2. Release Plan Advancement
      await this.advanceActivePlans(runs, controller.signal);
      if (this.disposed || !this.lease.isActive()) return;

      await this.options.runApprovalGrants?.reconcile(this.options.context, runs);
      if (this.disposed || !this.lease.isActive()) return;

      // 3. Pending Deployment Detection & Auto-Approval
      const actionablePendingCount = await this.processPendingDeployments(runs, controller.signal);
      if (this.disposed || !this.lease.isActive()) return;

      // 4. Unified Status Bar Refresh
      this.options.statusTicker.update(
        this.options.planStore.list(this.options.context.id),
        actionablePendingCount,
        this.options.context.id,
      );
    } catch {
      // Background polling swallows transient network/rate-limit/auth errors without crashing the host.
    } finally {
      if (this.inFlightAbort === controller) {
        this.inFlightAbort = undefined;
      }
      this.polling = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.inFlightAbort?.abort();
    this.inFlightAbort = undefined;
    this.lease.dispose();
  }

  private async loadRuns(signal: AbortSignal): Promise<WorkflowRunRecord[]> {
    if (this.options.ports?.loadRecentRuns) {
      const result = await this.options.ports.loadRecentRuns(signal);
      return result.runs;
    }
    const runRepo = new RunRepository(
      this.options.scheduler,
      this.options.context,
      this.token,
      this.lease,
    );
    const result = await runRepo.loadRecent(signal);
    return result.runs;
  }

  private createDispatchRepo(): DispatchSubmissionRepository {
    if (this.options.ports?.createDispatchRepository) {
      return this.options.ports.createDispatchRepository();
    }
    return new DispatchRepository(
      this.options.scheduler,
      this.options.context,
      this.token,
      this.lease,
    );
  }

  private createDeploymentRepo(): DeploymentReviewPort & {
    listPendingDeployments(runId: number, signal?: AbortSignal): Promise<PendingEnvironment[]>;
  } {
    if (this.options.ports?.createDeploymentRepository) {
      return this.options.ports.createDeploymentRepository();
    }
    return new DeploymentRepository(
      this.options.scheduler,
      this.options.context,
      this.token,
      this.lease,
    );
  }

  private async advanceActivePlans(runs: readonly WorkflowRunRecord[], signal: AbortSignal): Promise<void> {
    const plans = this.options.planStore.list(this.options.context.id);
    const dispatchRepo = this.createDispatchRepo();

    for (const plan of plans) {
      if (this.disposed || !this.lease.isActive()) return;
      if (plan.state !== "running" && plan.state !== "waiting_approval") continue;

      const currentStep = plan.steps[plan.currentStepIndex];
      if (!currentStep) continue;

      const resolution = this.resolveStepRun(currentStep, runs);
      if (!resolution) continue;
      if ("uncertain" in resolution) {
        await this.options.planService.markStepOutcomeUncertain(
          this.options.context.id,
          plan.id,
          resolution.uncertain,
        );
        continue;
      }
      const matched = resolution.run;

      await this.options.planService.advanceOnRunObserved(
        dispatchRepo,
        this.options.context,
        plan.id,
        {
          runId: matched.id,
          status: matched.status,
          conclusion: matched.conclusion,
          waitingApproval: matched.status === "waiting",
          htmlUrl: matched.htmlUrl,
        },
        undefined,
        signal,
      );
    }
  }

  private resolveStepRun(
    step: ReleasePlanStep,
    runs: readonly WorkflowRunRecord[],
  ): { readonly run: WorkflowRunRecord } | { readonly uncertain: "not_observed" | "ambiguous" } | undefined {
    if (step.runId !== undefined) {
      const known = runs.find((run) => run.id === step.runId);
      return known ? { run: known } : undefined;
    }
    if (step.state !== "request_accepted") return undefined;
    if (step.submittedAt === undefined || step.acceptedAt === undefined) return undefined;

    const association = associateDispatchRun(runs, {
      workflowId: step.workflowId,
      ref: step.ref,
      authenticatedUserId: this.options.context.authenticatedUserId ?? "",
      submittedAt: step.submittedAt,
      acceptedAt: step.acceptedAt,
    });
    if (association.state === "associated_run_found") return { run: association.run };
    if (association.state === "ambiguous") return { uncertain: "ambiguous" };
    const now = this.options.now?.() ?? Date.now();
    if (now > step.acceptedAt + ASSOCIATION_WINDOW_AFTER_ACCEPTANCE_MS) {
      return { uncertain: "not_observed" };
    }
    return undefined;
  }

  private async processPendingDeployments(runs: readonly WorkflowRunRecord[], signal: AbortSignal): Promise<number> {
    const waitingRuns = runs
      .filter((run) => run.status === "waiting")
      .slice(0, MAX_WAITING_DEPLOYMENT_CHECKS);
    if (waitingRuns.length === 0) return 0;

    const deploymentRepo = this.createDeploymentRepo();
    let actionableCount = 0;

    for (const run of waitingRuns) {
      if (this.disposed || !this.lease.isActive()) return actionableCount;
      let pendingEnvs: PendingEnvironment[];
      try {
        pendingEnvs = await deploymentRepo.listPendingDeployments(run.id, signal);
      } catch {
        continue;
      }

      const isOwnRun = this.isAuthenticatedUsersRun(run);
      const originalActorId = isOwnRun ? (this.options.context.authenticatedUserId ?? "") : "";
      if (isOwnRun) await this.applyOneRunApproval(run, pendingEnvs, deploymentRepo, signal);
      // A run with several pending environments always needs an explicit human selection.
      const allowAutoApproval = pendingEnvs.length === 1;

      for (const env of pendingEnvs) {
        if (!env.eligible) continue;

        const matchingRule = !allowAutoApproval ? undefined : this.options.autoApprovalService.findMatchingRule(this.options.context, {
          workflowId: run.workflowId ?? 0,
          environmentName: env.environmentName,
          ref: run.branch,
          originalActorId,
          eligible: env.eligible,
        });

        const dedupKey = `${run.id}:${env.environmentId}`;
        // GitHub may still report the environment as pending right after a successful review.
        if (this.succeededAutoApprovals.has(dedupKey)) continue;
        if (matchingRule && !this.autoApprovedKeys.has(dedupKey) && this.isActive()) {
          this.autoApprovedKeys.add(dedupKey);
          const auth = new UiAuthorization();
          auth.authorize({
            repositoryId: this.options.context.id,
            target: `review:run:${run.id}:envs:${env.environmentId}`,
            ref: "approved",
            inputs: { comment: "Auto-approved by ActionDeck rule" },
          });
          const results = await reviewPendingDeployments(
            deploymentRepo,
            this.options.context,
            auth,
            {
              runId: run.id,
              environmentIds: [env.environmentId],
              state: "approved",
              comment: "Auto-approved by ActionDeck rule",
            },
            signal,
          );
          const itemResult = results[0];
          if (itemResult) {
            await this.options.ports?.onAutoApprovalAudit?.({
              timestamp: Date.now(),
              repositoryId: this.options.context.id,
              runId: run.id,
              workflowId: run.workflowId ?? 0,
              environmentId: env.environmentId,
              environmentName: env.environmentName,
              ruleId: matchingRule.id,
              status: itemResult.status,
            });
            if (itemResult.status === "succeeded") {
              this.succeededAutoApprovals.add(dedupKey);
              continue;
            }
          }
        }

        actionableCount++;
        if (this.options.notificationService.shouldPromptApproval(
          this.options.context.id,
          this.options.authenticatedLogin,
          this.options.context.authenticatedUserId,
          run,
          env.environmentId,
        )) {
          await this.options.ports?.notifyApproval?.({
            repositoryId: this.options.context.id,
            runId: run.id,
            workflowId: run.workflowId ?? 0,
            title: run.displayTitle,
            branch: run.branch,
            environmentId: env.environmentId,
            environmentName: env.environmentName,
          });
        }
      }
    }

    return actionableCount;
  }

  /**
   * Approves the gates the user opted into when dispatching this exact run, from Run now or a plan step.
   * Several environments may be approved at once here, because the user chose them up front.
   */
  private async applyOneRunApproval(
    run: WorkflowRunRecord,
    pendingEnvs: readonly PendingEnvironment[],
    deploymentRepo: DeploymentReviewPort,
    signal: AbortSignal,
  ): Promise<void> {
    const scope = this.findOneRunScope(run.id);
    if (!scope) return;
    const covered = pendingEnvs.filter((env) => {
      const key = `${run.id}:${env.environmentId}`;
      return env.eligible &&
        scopeCoversEnvironment(scope.environments, env.environmentName) &&
        !this.succeededAutoApprovals.has(key) &&
        !this.autoApprovedKeys.has(key);
    });
    if (covered.length === 0 || !this.isActive()) return;
    for (const env of covered) this.autoApprovedKeys.add(`${run.id}:${env.environmentId}`);

    const comment = "Auto-approved by ActionDeck: opted in when this run was dispatched";
    const environmentIds = covered.map((env) => env.environmentId);
    const auth = new UiAuthorization();
    auth.authorize({
      repositoryId: this.options.context.id,
      target: `review:run:${run.id}:envs:${environmentIds.join(",")}`,
      ref: "approved",
      inputs: { comment },
    });
    const results = await reviewPendingDeployments(
      deploymentRepo,
      this.options.context,
      auth,
      { runId: run.id, environmentIds, state: "approved", comment },
      signal,
    );
    for (const result of results) {
      const env = covered.find((candidate) => candidate.environmentId === result.environmentId);
      if (!env) continue;
      await this.options.ports?.onAutoApprovalAudit?.({
        timestamp: Date.now(),
        repositoryId: this.options.context.id,
        runId: run.id,
        workflowId: run.workflowId ?? 0,
        environmentId: env.environmentId,
        environmentName: env.environmentName,
        ruleId: scope.source,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "succeeded") this.succeededAutoApprovals.add(`${run.id}:${env.environmentId}`);
    }
  }

  private findOneRunScope(runId: number): { readonly environments: readonly string[] | null; readonly source: string } | undefined {
    const grant = this.options.runApprovalGrants?.findForRun(this.options.context, runId);
    if (grant) return { environments: grant.environments, source: `run-grant:${grant.id}` };
    for (const plan of this.options.planStore.list(this.options.context.id)) {
      if (plan.state !== "running" && plan.state !== "waiting_approval") continue;
      const step = plan.steps.find((candidate) => candidate.runId === runId && candidate.autoApprove);
      if (step?.autoApprove) return { environments: step.autoApprove.environments, source: `plan:${plan.id}:${step.id}` };
    }
    return undefined;
  }

  private isAuthenticatedUsersRun(run: WorkflowRunRecord): boolean {
    return isOriginalActor(run, this.options.authenticatedLogin, this.options.context.authenticatedUserId);
  }
}
