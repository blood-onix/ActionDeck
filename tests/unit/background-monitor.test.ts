import { describe, expect, it, vi } from "vitest";
import { BackgroundMonitor } from "../../src/host/providers/background-monitor";
import { RepositoryScheduler } from "../../src/github/rate-limit/repository-scheduler";
import { PlanStore } from "../../src/persistence/plan-store";
import { ReleasePlanService } from "../../src/application/plans/plan-service";
import { SubscriptionStore } from "../../src/persistence/subscription-store";
import { NotificationService } from "../../src/application/runs/notification-service";
import { ApprovalRuleStore } from "../../src/persistence/approval-rule-store";
import { AutoApprovalService } from "../../src/application/approvals/auto-approval-service";
import { RunApprovalGrantService } from "../../src/application/approvals/run-approval-grants";
import { RunApprovalGrantStore } from "../../src/persistence/run-approval-grant-store";
import type { WorkflowRunRecord } from "../../src/domain/models/run";
import type { ReleasePlan } from "../../src/domain/models/release-plan";
import type { PendingEnvironment } from "../../src/domain/models/approval";
import type { DispatchSubmissionRepository } from "../../src/application/dispatch/dispatch-service";

class MemoryMemento {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

function makeRun(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    id: 100,
    workflowId: 1,
    attemptCount: 1,
    hydration: "summary",
    displayTitle: "Build",
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    branch: "main",
    headSha: "abc123",
    actor: { id: 42, login: "octocat" },
    createdAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    htmlUrl: "https://github.com/acme/demo/actions/runs/100",
    ...overrides,
  };
}

describe("BackgroundMonitor", () => {
  it("suppresses initial-hydration and teammate toasts, notifies once per own run attempt, and keeps running when dashboard lease is hidden/disposed", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const dashboardLease = scheduler.createLease(context.id, "dashboard");
    const planStore = new PlanStore(memento);
    const planService = new ReleasePlanService(planStore);
    const subscriptionStore = new SubscriptionStore(memento);
    const notificationService = new NotificationService(subscriptionStore);
    const autoApprovalService = new AutoApprovalService(new ApprovalRuleStore(memento));
    const statusUpdates: Array<{ plans: readonly ReleasePlan[]; pending: number }> = [];
    const notified: number[] = [];

    let pollRuns: WorkflowRunRecord[] = [
      makeRun({ id: 1, attemptCount: 1, actor: { id: 42, login: "octocat" } }),
    ];

    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService,
      notificationService,
      autoApprovalService,
      statusTicker: { update: (plans, pending = 0) => statusUpdates.push({ plans, pending }) },
      ports: {
        loadRecentRuns: async () => ({ runs: pollRuns }),
        notify: (n) => { notified.push(n.runId); },
      },
    });

    // Hide & dispose dashboard lease; background monitor lease remains active.
    dashboardLease.setVisible(false);
    dashboardLease.dispose();
    expect(monitor.isActive()).toBe(true);

    // Poll 1: initial hydration -> zero toasts
    await monitor.pollOnce();
    expect(notified).toEqual([]);

    // Poll 2: teammate run -> zero toasts; own run -> 1 toast; duplicate -> 0 more
    pollRuns = [
      makeRun({ id: 2, attemptCount: 1, actor: { id: 99, login: "teammate" } }),
      makeRun({ id: 3, attemptCount: 1, actor: { id: 42, login: "octocat" } }),
    ];
    await monitor.pollOnce();
    expect(notified).toEqual([3]);

    await monitor.pollOnce();
    expect(notified).toEqual([3]);

    monitor.dispose();
    expect(monitor.isActive()).toBe(false);
    scheduler.dispose();
  });

  it("keeps polling and shows each run's toast while an earlier toast is still open", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const notified: Array<string | undefined> = [];
    let pollRuns: WorkflowRunRecord[] = [];

    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore: new PlanStore(memento),
      planService: new ReleasePlanService(new PlanStore(memento)),
      notificationService: new NotificationService(new SubscriptionStore(memento)),
      autoApprovalService: new AutoApprovalService(new ApprovalRuleStore(memento)),
      statusTicker: { update: vi.fn() },
      ports: {
        loadRecentRuns: async () => ({ runs: pollRuns }),
        // A toast promise stays pending until the user dismisses it.
        notify: (n) => {
          notified.push(n.workflowName);
          return new Promise<void>(() => {});
        },
      },
    });

    await monitor.pollOnce();
    pollRuns = [
      makeRun({ id: 10, workflowId: 1, workflowName: "CI", displayTitle: "pr-#1 fix" }),
      makeRun({ id: 11, workflowId: 2, workflowName: "Lint", displayTitle: "pr-#1 fix" }),
    ];
    await monitor.pollOnce();
    expect(notified).toEqual(["CI", "Lint"]);

    await monitor.pollOnce();
    expect(notified).toEqual(["CI", "Lint"]);

    monitor.dispose();
    scheduler.dispose();
  });

  it("prompts for a pending approval while an earlier run toast is still open", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const prompts: string[] = [];
    let pollRuns: WorkflowRunRecord[] = [];

    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore: new PlanStore(memento),
      planService: new ReleasePlanService(new PlanStore(memento)),
      notificationService: new NotificationService(new SubscriptionStore(memento)),
      autoApprovalService: new AutoApprovalService(new ApprovalRuleStore(memento)),
      statusTicker: { update: vi.fn() },
      ports: {
        loadRecentRuns: async () => ({ runs: pollRuns }),
        notify: () => new Promise<void>(() => {}),
        createDeploymentRepository: () => ({
          listPendingDeployments: async (runId) => runId === 21
            ? [{ environmentId: 7, environmentName: "qa", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 }]
            : [],
          submitReview: async () => undefined,
        }),
        notifyApproval: (prompt) => {
          prompts.push(`${prompt.runId}:${prompt.environmentName}`);
          return new Promise<void>(() => {});
        },
      },
    });

    await monitor.pollOnce();
    pollRuns = [makeRun({ id: 20 })];
    await monitor.pollOnce();
    pollRuns = [makeRun({ id: 20 }), makeRun({ id: 21, status: "waiting", conclusion: null })];
    await monitor.pollOnce();
    expect(prompts).toEqual(["21:qa"]);

    monitor.dispose();
    scheduler.dispose();
  });

  it("advances a started release plan past step 1 when the step 1 run completes, and ignores unmatched runs", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const planStore = new PlanStore(memento);
    const statusTicker = { update: vi.fn() };
    const planService = new ReleasePlanService(planStore, (p) => statusTicker.update(planStore.list(p.repositoryId), 0));
    const notificationService = new NotificationService(new SubscriptionStore(memento));
    const autoApprovalService = new AutoApprovalService(new ApprovalRuleStore(memento));

    const dispatchedWorkflows: number[] = [];
    const dispatchRepo: DispatchSubmissionRepository = {
      loadTarget: async (workflowId) => ({
        state: "available",
        workflowId,
        workflowPath: `.github/workflows/${workflowId}.yml`,
        ref: "main",
        defaultBranch: "main",
        inputs: [],
      }),
      submit: async (workflowId) => {
        dispatchedWorkflows.push(workflowId);
      },
      listAssociationCandidates: async () => ({ runs: [], partial: false }),
    };

    const plan: ReleasePlan = {
      id: "plan-bg-1",
      name: "BG Release",
      repositoryId: context.id,
      state: "draft",
      currentStepIndex: 0,
      updatedAt: Date.now(),
      steps: [
        {
          id: "s1",
          workflowId: 10,
          workflowPath: ".github/workflows/build.yml",
          ref: "main",
          inputs: {},
          sensitiveInputKeys: [],
          gate: "stop_on_non_success",
          state: "pending",
        },
        {
          id: "s2",
          workflowId: 20,
          workflowPath: ".github/workflows/deploy.yml",
          ref: "main",
          inputs: {},
          sensitiveInputKeys: [],
          gate: "stop_on_non_success",
          state: "pending",
        },
      ],
    };
    await planService.savePlan(plan);
    await planService.startPlan(dispatchRepo, context, plan.id);
    expect(dispatchedWorkflows).toEqual([10]);

    let runs: WorkflowRunRecord[] = [
      // Unmatched run (different workflowId)
      makeRun({ id: 500, workflowId: 999, status: "completed", conclusion: "success" }),
    ];

    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService,
      notificationService,
      autoApprovalService,
      statusTicker,
      ports: {
        loadRecentRuns: async () => ({ runs }),
        createDispatchRepository: () => dispatchRepo,
      },
    });

    await monitor.pollOnce();
    expect(planStore.get(context.id, plan.id)?.currentStepIndex).toBe(0);
    expect(dispatchedWorkflows).toEqual([10]);

    // Step 1 run completes -> advances to step 2 and dispatches workflow 20
    runs = [
      makeRun({ id: 501, workflowId: 10, branch: "main", status: "completed", conclusion: "success" }),
    ];
    await monitor.pollOnce();

    const updated = planStore.get(context.id, plan.id);
    expect(updated?.currentStepIndex).toBe(1);
    expect(updated?.steps[0]?.state).toBe("completed");
    expect(dispatchedWorkflows).toEqual([10, 20]);

    monitor.dispose();
    scheduler.dispose();
  });

  it("associates dispatched steps strictly and blocks plans as uncertain on ambiguity or an expired window", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const planStore = new PlanStore(memento);
    const planService = new ReleasePlanService(planStore);
    const notificationService = new NotificationService(new SubscriptionStore(memento));
    const autoApprovalService = new AutoApprovalService(new ApprovalRuleStore(memento));
    const dispatchRepo: DispatchSubmissionRepository = {
      loadTarget: async (workflowId) => ({
        state: "available",
        workflowId,
        workflowPath: ".github/workflows/build.yml",
        ref: "main",
        defaultBranch: "main",
        inputs: [],
      }),
      submit: async () => {},
      listAssociationCandidates: async () => ({ runs: [], partial: false }),
    };
    const step = {
      workflowId: 10,
      workflowPath: ".github/workflows/build.yml",
      ref: "main",
      inputs: {},
      sensitiveInputKeys: [],
      gate: "stop_on_non_success" as const,
    };
    const submittedAt = Date.now();
    const acceptedAt = submittedAt + 500;
    const accepted = (id: string): ReleasePlan => ({
      id,
      name: id,
      repositoryId: context.id,
      state: "running",
      currentStepIndex: 0,
      updatedAt: submittedAt,
      steps: [{ ...step, id: `${id}-s1`, state: "request_accepted", submittedAt, acceptedAt }],
    });
    await planService.savePlan(accepted("p-ok"));
    await planService.savePlan(accepted("p-ambiguous"));
    let now = acceptedAt + 5_000;
    let runs: WorkflowRunRecord[] = [
      makeRun({ id: 1, workflowId: 10, event: "push", createdAt: new Date(acceptedAt).toISOString() }),
      makeRun({ id: 2, workflowId: 10, actor: { id: 7, login: "other" }, createdAt: new Date(acceptedAt).toISOString() }),
    ];
    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService,
      notificationService,
      autoApprovalService,
      statusTicker: { update: vi.fn() },
      now: () => now,
      ports: {
        loadRecentRuns: async () => ({ runs }),
        createDispatchRepository: () => dispatchRepo,
      },
    });

    await monitor.pollOnce();
    expect(planStore.get(context.id, "p-ok")?.steps[0]?.state).toBe("request_accepted");

    runs = [
      makeRun({ id: 3, workflowId: 10, status: "in_progress", conclusion: null, createdAt: new Date(acceptedAt).toISOString() }),
      makeRun({ id: 4, workflowId: 10, status: "in_progress", conclusion: null, createdAt: new Date(acceptedAt + 1_000).toISOString() }),
    ];
    await monitor.pollOnce();
    expect(planStore.get(context.id, "p-ok")?.state).toBe("blocked_uncertain");
    expect(planStore.get(context.id, "p-ambiguous")?.steps[0]?.state).toBe("outcome_uncertain");

    await planService.savePlan(accepted("p-expired"));
    runs = [];
    now = acceptedAt + 121_000;
    await monitor.pollOnce();
    const expired = planStore.get(context.id, "p-expired");
    expect(expired?.state).toBe("blocked_uncertain");
    expect(expired?.steps[0]?.error).toBe("not_observed");

    monitor.dispose();
    scheduler.dispose();
  });

  it("auto-approves only eligible own runs matching a rule, records audit outcomes, and updates actionable pending count", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const planStore = new PlanStore(memento);
    const planService = new ReleasePlanService(planStore);
    const notificationService = new NotificationService(new SubscriptionStore(memento));
    const autoApprovalService = new AutoApprovalService(new ApprovalRuleStore(memento));
    const statusUpdates: number[] = [];
    const audits: Array<{ runId: number; environmentName: string; status: string }> = [];
    const submittedReviews: Array<{ runId: number; environmentId: number }> = [];
    const prompts: string[] = [];

    await autoApprovalService.saveRule({
      id: "rule-1",
      repositoryId: context.id,
      workflowId: 10,
      environmentName: "staging",
      ref: "main",
      authenticatedUserId: "42",
      enabled: true,
      createdAt: Date.now(),
    });

    const runs: WorkflowRunRecord[] = [
      // Own waiting run with a single eligible staging environment (auto-approved)
      makeRun({ id: 701, workflowId: 10, branch: "main", status: "waiting", conclusion: null, actor: { id: 42, login: "octocat" } }),
      // Teammate waiting run with eligible staging (must NOT auto-approve, but counts as 1 actionable pending approval)
      makeRun({ id: 702, workflowId: 10, branch: "main", status: "waiting", conclusion: null, actor: { id: 99, login: "teammate" } }),
      // Own waiting run with several pending environments (rules never act; one prompt per environment)
      makeRun({ id: 704, workflowId: 10, branch: "main", status: "waiting", conclusion: null, actor: { id: 42, login: "octocat" } }),
      // Queued run (must NOT be checked or counted as pending approval)
      makeRun({ id: 703, workflowId: 10, branch: "main", status: "queued", conclusion: null, actor: { id: 42, login: "octocat" } }),
    ];

    const pendingByRun: Record<number, PendingEnvironment[]> = {
      701: [
        { environmentId: 1, environmentName: "staging", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
      ],
      704: [
        { environmentId: 1, environmentName: "staging", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
        { environmentId: 2, environmentName: "prod", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
      ],
      702: [
        { environmentId: 1, environmentName: "staging", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
      ],
    };

    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService,
      notificationService,
      autoApprovalService,
      statusTicker: { update: (_plans, pending = 0) => statusUpdates.push(pending) },
      ports: {
        loadRecentRuns: async () => ({ runs }),
        createDeploymentRepository: () => ({
          listPendingDeployments: async (runId) => pendingByRun[runId] ?? [],
          submitReview: async (runId, environmentId) => {
            submittedReviews.push({ runId, environmentId });
          },
        }),
        notifyApproval: (prompt) => { prompts.push(`${prompt.runId}:${prompt.environmentName}`); },
        onAutoApprovalAudit: (entry) => {
          audits.push({ runId: entry.runId, environmentName: entry.environmentName, status: entry.status });
        },
      },
    });

    await monitor.pollOnce();

    expect(submittedReviews).toEqual([{ runId: 701, environmentId: 1 }]);
    expect(audits).toEqual([{ runId: 701, environmentName: "staging", status: "succeeded" }]);
    // 701 auto-approved; 702 staging and 704 staging+prod remain actionable -> count = 3
    expect(statusUpdates).toEqual([3]);
    // Teammate run 702 is outside My Runs Only; own multi-environment run 704 prompts once per environment.
    expect(prompts).toEqual(["704:staging", "704:prod"]);
    await monitor.pollOnce();
    expect(prompts).toEqual(["704:staging", "704:prod"]);
    expect(submittedReviews).toEqual([{ runId: 701, environmentId: 1 }]);

    // After disposal (e.g. identity change), pollOnce is a no-op
    monitor.dispose();
    await monitor.pollOnce();
    expect(submittedReviews).toEqual([{ runId: 701, environmentId: 1 }]);
    scheduler.dispose();
  });

  it("approves only the dispatched run a one-run grant binds to, covering several environments, and drops ambiguous grants", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const planStore = new PlanStore(memento);
    const planService = new ReleasePlanService(planStore);
    const notificationService = new NotificationService(new SubscriptionStore(memento));
    const autoApprovalService = new AutoApprovalService(new ApprovalRuleStore(memento));
    const grants = new RunApprovalGrantService(new RunApprovalGrantStore(memento));
    const submittedReviews: Array<{ runId: number; environmentId: number }> = [];
    const audits: Array<{ runId: number; ruleId: string; status: string }> = [];
    const submittedAt = Date.now() - 5_000;

    await grants.grant(context, { workflowId: 10, ref: "main", environments: ["dev", "QA"], submittedAt, acceptedAt: submittedAt + 500 });
    await grants.grant(context, { workflowId: 20, ref: "main", environments: null, submittedAt, acceptedAt: submittedAt + 500 });

    const recent = new Date(submittedAt + 1_000).toISOString();
    const runs: WorkflowRunRecord[] = [
      // The run the workflow-10 grant was given for.
      makeRun({ id: 801, workflowId: 10, status: "waiting", conclusion: null, createdAt: recent }),
      // An older run of the same workflow: outside the dispatch window, never covered.
      makeRun({ id: 802, workflowId: 10, status: "waiting", conclusion: null, createdAt: new Date(submittedAt - 600_000).toISOString() }),
      // Two candidate runs for workflow 20: ambiguous, so the grant is dropped.
      makeRun({ id: 803, workflowId: 20, status: "waiting", conclusion: null, createdAt: recent }),
      makeRun({ id: 804, workflowId: 20, status: "waiting", conclusion: null, createdAt: recent }),
    ];
    const env = (environmentId: number, environmentName: string): PendingEnvironment => ({
      environmentId, environmentName, eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0,
    });
    const pendingByRun: Record<number, PendingEnvironment[]> = {
      801: [env(1, "dev"), env(2, "qa"), env(3, "prod")],
      802: [env(1, "dev")],
      803: [env(1, "dev")],
      804: [env(1, "dev")],
    };

    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService,
      notificationService,
      autoApprovalService,
      runApprovalGrants: grants,
      statusTicker: { update: () => {} },
      ports: {
        loadRecentRuns: async () => ({ runs }),
        createDeploymentRepository: () => ({
          listPendingDeployments: async (runId) => pendingByRun[runId] ?? [],
          submitReview: async (runId, environmentId) => {
            submittedReviews.push({ runId, environmentId });
          },
        }),
        onAutoApprovalAudit: (entry) => {
          audits.push({ runId: entry.runId, ruleId: entry.ruleId, status: entry.status });
        },
      },
    });

    await monitor.pollOnce();

    expect(submittedReviews).toEqual([{ runId: 801, environmentId: 1 }, { runId: 801, environmentId: 2 }]);
    expect(audits.every((audit) => audit.runId === 801 && audit.ruleId.startsWith("run-grant:"))).toBe(true);
    expect(grants.list(context.id).map((grant) => [grant.workflowId, grant.runId])).toEqual([[10, 801]]);

    // Once the run finishes, its grant is gone and cannot match anything else.
    runs[0] = { ...runs[0]!, status: "completed", conclusion: "success" };
    await monitor.pollOnce();
    expect(grants.list(context.id)).toEqual([]);
    monitor.dispose();
    scheduler.dispose();
  });

  it("approves a running plan step's run when the step opted in", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const planStore = new PlanStore(memento);
    const planService = new ReleasePlanService(planStore);
    const submittedReviews: number[] = [];
    await planStore.save({
      id: "plan-1",
      name: "Scheduled terraform",
      repositoryId: context.id,
      state: "waiting_approval",
      currentStepIndex: 0,
      updatedAt: Date.now(),
      steps: [{
        id: "step-1",
        workflowId: 10,
        workflowPath: ".github/workflows/terraform.yml",
        ref: "main",
        inputs: { environment: "prod" },
        sensitiveInputKeys: [],
        gate: "stop_on_non_success",
        autoApprove: { environments: ["prod"] },
        state: "waiting_approval",
        runId: 901,
      }],
    });
    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService,
      notificationService: new NotificationService(new SubscriptionStore(memento)),
      autoApprovalService: new AutoApprovalService(new ApprovalRuleStore(memento)),
      statusTicker: { update: () => {} },
      ports: {
        loadRecentRuns: async () => ({
          runs: [makeRun({ id: 901, workflowId: 10, status: "waiting", conclusion: null })],
        }),
        createDispatchRepository: () => ({}) as unknown as DispatchSubmissionRepository,
        createDeploymentRepository: () => ({
          listPendingDeployments: async () => [
            { environmentId: 7, environmentName: "prod", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0 },
          ],
          submitReview: async (_runId, environmentId) => {
            submittedReviews.push(environmentId);
          },
        }),
      },
    });
    await monitor.pollOnce();
    expect(submittedReviews).toEqual([7]);
    monitor.dispose();
    scheduler.dispose();
  });
  it("notifies instead of silently dropping an own-run gate the account cannot approve, and audits the skipped opt-in", async () => {
    const memento = new MemoryMemento();
    const scheduler = new RepositoryScheduler(3);
    const planStore = new PlanStore(memento);
    const grants = new RunApprovalGrantService(new RunApprovalGrantStore(memento));
    const submitted: number[] = [];
    const prompts: Array<{ runId: number; canApprove: boolean; autoApprovalBlocked?: boolean; reason?: string }> = [];
    const audits: Array<{ status: string; error?: string }> = [];
    const ineligible: string[] = [];
    const statusCounts: number[] = [];
    const submittedAt = Date.now() - 5_000;
    // Reusable-workflow environments are unresolved, so the grant covers every gate.
    await grants.grant(context, { workflowId: 30, ref: "main", environments: null, submittedAt, acceptedAt: submittedAt + 500 });
    const recent = new Date(submittedAt + 1_000).toISOString();
    const runs = [
      makeRun({ id: 1001, workflowId: 30, status: "waiting", conclusion: null, createdAt: recent }),
      // A teammate's run on a gate this account cannot approve is not the user's business.
      makeRun({ id: 1002, workflowId: 31, status: "waiting", conclusion: null, actor: { id: 99, login: "teammate" } }),
      // A wait timer clears by itself: no prompt.
      makeRun({ id: 1003, workflowId: 32, status: "waiting", conclusion: null }),
    ];
    const blocked: PendingEnvironment = {
      environmentId: 5,
      environmentName: "dev",
      eligible: false,
      currentUserCanApprove: false,
      waitTimerRemainingSeconds: 0,
      requiredReviewers: ["team-twins-infra"],
      reason: "Authenticated user is not an authorized reviewer for this environment.",
    };
    const pendingByRun: Record<number, PendingEnvironment[]> = {
      1001: [blocked],
      1002: [blocked],
      1003: [{ environmentId: 6, environmentName: "qa", eligible: false, currentUserCanApprove: true, waitTimerRemainingSeconds: 60 }],
    };
    const monitor = new BackgroundMonitor({
      context,
      authenticatedLogin: "octocat",
      token: "tok",
      scheduler,
      planStore,
      planService: new ReleasePlanService(planStore),
      notificationService: new NotificationService(new SubscriptionStore(memento)),
      autoApprovalService: new AutoApprovalService(new ApprovalRuleStore(memento)),
      runApprovalGrants: grants,
      statusTicker: { update: (_plans, pending) => { statusCounts.push(pending); } },
      ports: {
        loadRecentRuns: async () => ({ runs }),
        createDispatchRepository: () => ({}) as unknown as DispatchSubmissionRepository,
        createDeploymentRepository: () => ({
          listPendingDeployments: async (runId) => pendingByRun[runId] ?? [],
          submitReview: async (_runId, environmentId) => {
            submitted.push(environmentId);
          },
        }),
        notifyApproval: (prompt) => {
          prompts.push({
            runId: prompt.runId,
            canApprove: prompt.canApprove,
            ...(prompt.autoApprovalBlocked ? { autoApprovalBlocked: true } : {}),
            ...(prompt.reason ? { reason: prompt.reason } : {}),
          });
        },
        onAutoApprovalAudit: (entry) => {
          audits.push({ status: entry.status, ...(entry.error ? { error: entry.error } : {}) });
        },
        onIneligibleGate: (details) => {
          ineligible.push(`${details.runId}:${details.environmentName}`);
        },
      },
    });

    await monitor.pollOnce();
    await monitor.pollOnce();

    expect(submitted).toEqual([]);
    expect(prompts).toEqual([{ runId: 1001, canApprove: false, autoApprovalBlocked: true, reason: blocked.reason }]);
    expect(audits).toEqual([{ status: "skipped", error: blocked.reason }]);
    expect(ineligible).toEqual(["1001:dev"]);
    // Nothing ActionDeck can act on, so the actionable count stays at zero.
    expect(statusCounts).toEqual([0, 0]);

    // Once GitHub reports the gate as approvable (for example after granting read:org), the opt-in applies.
    pendingByRun[1001] = [{ ...blocked, eligible: true, currentUserCanApprove: true }];
    await monitor.pollOnce();
    expect(submitted).toEqual([5]);
    monitor.dispose();
    scheduler.dispose();
  });
});
