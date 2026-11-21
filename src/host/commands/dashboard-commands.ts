import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { discoverLocalWorkflows } from "../../application/workflows/local-workflows";
import { buildDashboard, latestRunPatches } from "../../application/workflows/dashboard-service";
import { latestRunsByWorkflowPath, normalizeWorkflowPath } from "../../application/workflows/latest-run";
import { inspectLocalWorkflowPreview } from "../../application/workflows/local-preview";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import { RepositoryScheduler } from "../../github/rate-limit/repository-scheduler";
import { WorkflowRepository } from "../../github/repositories/workflow-repository";
import { RunRepository } from "../../github/repositories/run-repository";
import { JobRepository } from "../../github/repositories/job-repository";
import { DispatchRepository } from "../../github/repositories/dispatch-repository";
import { inspectRun, loadJobLogProjection } from "../../application/runs/inspection-service";
import { executeRunAction } from "../../application/runs/run-actions";
import { checkDispatchAssociation, executeDispatch } from "../../application/dispatch/dispatch-service";
import { validateRemoteDispatchInputs } from "../../application/dispatch/dispatch-validation";
import { executeBatchDispatch } from "../../application/dispatch/batch-service";
import { analyzeBatchInputCompatibility, resolveBatchTargets } from "../../domain/services/input-compatibility";
import { PlanStore } from "../../persistence/plan-store";
import { ReleasePlanService } from "../../application/plans/plan-service";
import { LocalPlanScheduler } from "../../application/plans/local-scheduler";
import { PlanStatusBarTicker } from "../providers/plan-status";
import { planControlPayload, planSavePayload } from "../../protocol/plans";
import { SubscriptionStore } from "../../persistence/subscription-store";
import { ApprovalRuleStore } from "../../persistence/approval-rule-store";
import { AutoApprovalService } from "../../application/approvals/auto-approval-service";
import { RunApprovalGrantService } from "../../application/approvals/run-approval-grants";
import { RunApprovalGrantStore } from "../../persistence/run-approval-grant-store";
import { resolveAutoApprovalScope } from "../../domain/services/auto-approval-scope";
import type { WorkflowEnvironmentRef } from "../../domain/models/dispatch";
import { DeploymentRepository } from "../../github/repositories/deployment-repository";
import { reviewPendingDeployments } from "../../application/approvals/approval-service";
import {
  approvalRuleSavePayload,
  approvalRuleSetEnabledPayload,
  deploymentListPayload,
  deploymentReviewPayload,
  subscriptionUpdatePayload,
} from "../../protocol/approvals";
import { SettingsRepository } from "../../github/repositories/settings-repository";
import { loadSettingsCard } from "../../application/repositories/settings-service";
import { settingsLoadCardPayload } from "../../protocol/settings";
import { UiAuthorization } from "../../application/dispatch/authorization";
import { classifyGitHubError } from "../../github/client/classify-error";
import { createGitHubClient } from "../../github/client/github-client";
import { parseSupportedGitHubRunUrl } from "../../domain/services/external-links";
import { runMetrics } from "../../domain/services/run-metrics";
import { hostEvent } from "../../protocol/envelopes";
import { approvalAuditSchema, dashboardDataSchema, tabWorkflowPathPattern, viewOpenInTabPayload } from "../../protocol/dashboard";
import { columnLayoutSavePayload, columnLayoutSchema, workflowGroupsSchema, workflowSetGroupPayload } from "../../protocol/preferences";
import type { ReleasePlan } from "../../domain/models/release-plan";
import type { WorkflowRunRecord } from "../../domain/models/run";
import {
  planExplainBlockedPayload,
  runActionPayload,
  runInspectPayload,
  runInvestigatePayload,
  runOpenChatPayload,
  runLogsPayload,
} from "../../protocol/runs";
import {
  dispatchAssociationPayload,
  dispatchSubmitPayload,
  dispatchValidatePayload,
  repositoryBranchesPayload,
  workflowProposeFixPayload,
} from "../../protocol/dispatch";
import { batchSubmitPayload, batchValidatePayload } from "../../protocol/batch";
import { createVsCodeLanguageModelAdapter, openRunInCopilotChat, runFailureInvestigation } from "./copilot-commands";
import { explainBlockedPlan } from "../../application/copilot/plan-explanation";
import { openWorkflowFixDiff, proposeCommentPreservingYamlFix, WorkflowProposalProvider } from "../providers/workflow-diff";
import {
  getGitHubSession,
  hasPrivateRepositoryAccess,
  requestPrivateRepositoryAccess,
  withPrivateRepositoryEscalation,
} from "../providers/github-authentication";
import { watchWorkflowFiles } from "../providers/workflow-file-watcher";
import { createDashboardPanel } from "../webviews/panel-factory";
import { selectRepository } from "./repository-commands";
import { DispatchInputHistory } from "../../application/dispatch/dispatch-input-history";
import { currentWorkspaceBranch, discoverWorkspaceRepositories } from "../providers/workspace-repositories";
import { createRepositoryContext } from "../../application/repositories/repository-service";
import { recoverInterruptedPlans } from "../../application/plans/plan-recovery";
import { NotificationService } from "../../application/runs/notification-service";
import { BackgroundMonitor } from "../providers/background-monitor";
import { RepositoryState } from "../../persistence/workspace-state";
import {
  LauncherStateStore,
  type RepositorySortOrder,
  type WorkflowSortOrder,
} from "../../persistence/launcher-state-store";
import { HISTORY_PAGE_SIZE, MAX_HISTORY_PAGES, RepositoryViewCache, type MergedHistory } from "../../application/runs/view-cache";
import {
  isWorkspaceTreeNode,
  repositoryNodeId,
  WorkspaceTreeProvider,
  type WorkflowTreeNode,
  type WorkspaceTreeNode,
} from "../providers/workspace-tree";
import { onDidChangeWorkspaceRepositories, type RepositoryChoice } from "../providers/workspace-repositories";
import {
  isWorkflowDocument,
  latestRunLabel,
  WORKFLOW_FILE_PATTERN,
  WorkflowCodeLensProvider,
  type LatestRunSummary,
  type WorkflowEditorAction,
} from "../providers/workflow-codelens";

export interface DashboardRuntime {
  getActiveContext(): RepositoryContext | undefined;
  getScheduler(): RepositoryScheduler;
  getPlanStore(): PlanStore;
  getPlanService(): ReleasePlanService;
}

export function registerDashboardCommands(
  context: vscode.ExtensionContext,
  proposalProvider?: WorkflowProposalProvider,
): DashboardRuntime {
  let selectedContext: RepositoryContext | undefined;
  let selectedSession: vscode.AuthenticationSession | undefined;
  let identityGeneration = 0;
  const panelSessionRefreshers = new Map<string, Set<(retriggerDashboard?: boolean) => void>>();
  /** Open dashboards listening for plan changes made in the background (monitor, scheduler). */
  const planObservers = new Set<(plan: ReleasePlan) => void>();
  /** Open dashboards listening for runs seen by a repository's background poll, keyed by repository id. */
  const runObservers = new Map<string, Set<(runs: readonly WorkflowRunRecord[]) => void>>();
  const scheduler = new RepositoryScheduler(3);
  // Shared by every tab: views render cached data first and revalidate in the background.
  const viewCache = new RepositoryViewCache();
  const mementoAdapter = {
    get: <T>(key: string) => context.workspaceState.get<T>(key),
    update: (key: string, value: unknown) => Promise.resolve(context.workspaceState.update(key, value)),
  };
  const planStore = new PlanStore(mementoAdapter);
  const subscriptionStore = new SubscriptionStore(mementoAdapter);
  const approvalRuleStore = new ApprovalRuleStore(mementoAdapter);
  const notificationService = new NotificationService(subscriptionStore);
  const autoApprovalService = new AutoApprovalService(approvalRuleStore);
  const runApprovalGrants = new RunApprovalGrantService(new RunApprovalGrantStore(mementoAdapter));
  const statusTicker = new PlanStatusBarTicker();
  // Latest-run summaries keyed by repository then workflow path; fed by both the dashboard and background polling.
  const latestRunsByRepository = new Map<string, Map<string, LatestRunSummary>>();
  const availabilityByRepository = new Map<string, Map<string, string>>();
  // One monitor and one immutable context per repository keeps plans bound to the repository that created them.
  const monitors = new Map<string, BackgroundMonitor>();
  const boundContexts = new Map<string, RepositoryContext>();
  const lookupWorkflowEntry = <T,>(
    mapByRepo: ReadonlyMap<string, ReadonlyMap<string, T>>,
    uri: vscode.Uri,
  ): T | undefined => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const rel = normalizeWorkflowPath(posix.relative(folder.uri.path, uri.path));
    const folderUri = folder.uri.toString();
    for (const [repositoryId, entries] of mapByRepo) {
      const candidate = boundContexts.get(repositoryId);
      if (candidate?.workspaceFolderUri === folderUri && entries.has(rel)) return entries.get(rel);
    }
    return undefined;
  };
  const codeLensProvider = new WorkflowCodeLensProvider(
    (uri) => lookupWorkflowEntry(latestRunsByRepository, uri),
    (uri) => lookupWorkflowEntry(availabilityByRepository, uri),
  );
  const launcherState = new LauncherStateStore(mementoAdapter);
  const lookupLatestRunForChoice = (choice: RepositoryChoice, workflowPath: string): LatestRunSummary | undefined => {
    const id = createRepositoryContext(choice.folder.uri.toString(), choice.remoteName, choice.owner, choice.repo).id;
    return latestRunsByRepository.get(id)?.get(normalizeWorkflowPath(workflowPath));
  };
  const workspaceTree = new WorkspaceTreeProvider({
    discoverRepositories: discoverWorkspaceRepositories,
    latestRun: lookupLatestRunForChoice,
    launcherState,
  });
  const refreshLatestRunViews = () => {
    codeLensProvider.refresh();
    workspaceTree.refresh();
  };
  const planService = new ReleasePlanService(planStore, (updated) => {
    statusTicker.updatePlans(updated.repositoryId, planStore.list(updated.repositoryId));
    for (const observe of planObservers) observe(updated);
  });
  const localPlanScheduler = new LocalPlanScheduler(planStore, { now: () => Date.now() }, async (planId) => {
    const bound = [...boundContexts.values()].find((candidate) => planStore.get(candidate.id, planId));
    if (!bound) return;
    const plan = planStore.get(bound.id, planId);
    if (!plan) return;
    const pauseWith = async (reason: string) => {
      await planService.savePlan({ ...plan, state: "paused", blockedReason: reason });
    };
    const session = await getGitHubSession(false);
    if (!session || (bound.authenticatedUserId && session.account.id !== bound.authenticatedUserId)) {
      await pauseWith("Scheduled start paused because the GitHub identity for this repository is unavailable.");
      return;
    }
    const repoContext = bound.authenticatedUserId ? bound : { ...bound, authenticatedUserId: session.account.id };
    ensureBackgroundMonitor(repoContext, session);
    try {
      const repo = new DispatchRepository(scheduler, repoContext, session.accessToken);
      await planService.startPlan(repo, repoContext, planId);
    } catch (error) {
      await pauseWith(error instanceof AppError ? error.message : "Scheduled start failed before dispatch.");
    }
  });

  const ensureBackgroundMonitor = (repoContext: RepositoryContext, session: vscode.AuthenticationSession) => {
    const existing = monitors.get(repoContext.id);
    if (existing?.isActive() && boundContexts.get(repoContext.id)?.authenticatedUserId === repoContext.authenticatedUserId) {
      existing.updateToken(session.accessToken);
      return;
    }
    existing?.dispose();
    boundContexts.set(repoContext.id, repoContext);
    const repoState = new RepositoryState(mementoAdapter, repoContext.id);
    const monitor = new BackgroundMonitor({
      context: repoContext,
      authenticatedLogin: session.account.label,
      token: session.accessToken,
      scheduler,
      planStore,
      planService,
      notificationService,
      autoApprovalService,
      runApprovalGrants,
      statusTicker,
      ports: {
        notify: async (notification) => {
          const rerunBy = notification.triggeringActor ? `, re-run by ${notification.triggeringActor}` : "";
          const message = `${notification.title} (${notification.conclusion ?? "completed"}${rerunBy})`;
          const show = notification.conclusion === "failure" || notification.conclusion === "timed_out"
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
          const action = await show(message, "Inspect Run");
          if (action === "Inspect Run" && await selectBoundRepository(notification.repositoryId)) {
            await vscode.commands.executeCommand("actiondeck.openDashboard", undefined, undefined, notification.runId);
          }
        },
        notifyApproval: async (prompt) => {
          const action = await vscode.window.showInformationMessage(
            `Approval needed for "${prompt.title}" on ${prompt.branch}: environment ${prompt.environmentName}`,
            "Open Action Center",
          );
          if (action === "Open Action Center" && await selectBoundRepository(prompt.repositoryId)) {
            await vscode.commands.executeCommand("actiondeck.openDashboard", undefined, undefined, undefined, "action-center");
          }
        },
        onRunsObserved: (runs) => {
          const summaries = latestRunsByRepository.get(repoContext.id) ?? new Map<string, LatestRunSummary>();
          for (const [path, latest] of latestRunsByWorkflowPath(runs)) summaries.set(path, latest);
          latestRunsByRepository.set(repoContext.id, summaries);
          refreshLatestRunViews();
          for (const observe of runObservers.get(repoContext.id) ?? []) observe(runs);
        },
        onAutoApprovalAudit: async (entry) => {
          const existing = repoState.get<unknown[]>("autoApprovalAudit");
          const list = Array.isArray(existing) ? existing : [];
          await repoState.update("autoApprovalAudit", [...list.slice(-49), entry]);
        },
      },
    });
    monitors.set(repoContext.id, monitor);
    monitor.start();
    void monitor.pollOnce();
  };

  const selectBoundRepository = async (repositoryId: string): Promise<boolean> => {
    if (selectedContext?.id === repositoryId) return true;
    const target = boundContexts.get(repositoryId);
    const session = await getGitHubSession(false);
    if (!target || !session || session.account.id !== target.authenticatedUserId) return false;
    if (selectedContext) scheduler.invalidate(selectedContext.id);
    selectedContext = target;
    selectedSession = session;
    identityGeneration++;
    return true;
  };

  const disposeMonitor = (repositoryId: string) => {
    monitors.get(repositoryId)?.dispose();
    monitors.delete(repositoryId);
  };

  void (async () => {
    try {
      const repos = discoverWorkspaceRepositories();
      if (repos.length === 0) return;
      const session = await getGitHubSession(false);
      for (const choice of repos) {
        const repoContext = createRepositoryContext(
          choice.folder.uri.toString(),
          choice.remoteName,
          choice.owner,
          choice.repo,
          session?.account.id ?? "",
        );
        const existingPlans = planStore.list(repoContext.id);
        if (existingPlans.length === 0) continue;
        boundContexts.set(repoContext.id, repoContext);
        await recoverInterruptedPlans(planStore, repoContext.id, {
          reconcileStep: async (_plan, step) => {
            if (!session?.accessToken) return { state: "outcome_uncertain" };
            try {
              const runRepo = new RunRepository(scheduler, repoContext, session.accessToken);
              const recent = await runRepo.loadRecent();
              const matched = step.runId !== undefined
                ? recent.runs.find((r) => r.id === step.runId)
                : undefined;
              if (!matched) return { state: "outcome_uncertain" };
              if (matched.status === "completed") {
                return {
                  state: "completed",
                  runId: matched.id,
                  conclusion: matched.conclusion,
                  htmlUrl: matched.htmlUrl,
                };
              }
              return {
                state: matched.status === "waiting" ? "waiting_approval" : "running",
                runId: matched.id,
                htmlUrl: matched.htmlUrl,
              };
            } catch {
              return { state: "outcome_uncertain" };
            }
          },
        });
        for (const plan of planStore.list(repoContext.id)) {
          if (plan.state === "scheduled") {
            const evaluated = localPlanScheduler.scheduleOrDetectMissed(plan);
            if (evaluated.state === "missed_schedule") {
              await planService.savePlan(evaluated);
            }
          }
        }
        const restoredPlans = planStore.list(repoContext.id);
        statusTicker.update(restoredPlans, 0, repoContext.id);
        const needsMonitoring = restoredPlans.some((plan) =>
          plan.state === "running" || plan.state === "waiting_approval" || plan.state === "scheduled",
        );
        if (session && needsMonitoring) ensureBackgroundMonitor(repoContext, session);
      }
    } catch {
      // Activation recovery should never block or fail extension startup.
    }
  })();

  const select = vscode.commands.registerCommand("actiondeck.selectRepository", async () => {
    const previousId = selectedContext?.id;
    selectedContext = await selectRepository();
    if (previousId && selectedContext?.id !== previousId) {
      scheduler.invalidate(previousId);
    }
    if (previousId !== selectedContext?.id) identityGeneration++;
    selectedSession = await getGitHubSession(false);
    if (selectedContext && selectedSession) {
      ensureBackgroundMonitor(selectedContext, selectedSession);
    }
  });
  const open = vscode.commands.registerCommand(
    "actiondeck.openDashboard",
    async (workflowPathValue?: unknown, actionValue?: unknown, runIdValue?: unknown, viewValue?: unknown) => {
    const initialView = viewValue === "action-center" ? "action-center" as const : undefined;
    const isLocalWorkflowPath = typeof workflowPathValue === "string" &&
      /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(workflowPathValue);
    // Dynamic workflows (no local file) can only be opened as a pipeline tab.
    const workflowPath = typeof workflowPathValue === "string" &&
      (isLocalWorkflowPath || (actionValue === "pipeline" && tabWorkflowPathPattern.test(workflowPathValue)))
      ? workflowPathValue
      : undefined;
    const initialAction: WorkflowEditorAction | undefined = actionValue === "latest-run" || actionValue === "pipeline"
      ? actionValue
      : workflowPath ? "companion" : undefined;
    const initialRunId = typeof runIdValue === "number" && Number.isInteger(runIdValue) && runIdValue > 0
      ? runIdValue
      : undefined;
    if (!selectedContext) {
      selectedContext = await selectRepository();
      selectedSession = await getGitHubSession(false);
    }
    if (!selectedContext || !selectedSession) return;
    ensureBackgroundMonitor(selectedContext, selectedSession);
    const activeContext = selectedContext;
    const activeSession = selectedSession;
    let panelSession = activeSession;
    let activeGeneration = identityGeneration;
    let lastLoadHadInventoryOrHistoryFailure = false;
    const folder = (vscode.workspace.workspaceFolders ?? []).find((item) => item.uri.toString() === activeContext.workspaceFolderUri);
    if (!folder) {
      void vscode.window.showErrorMessage("The selected repository workspace folder is no longer open.");
      return;
    }
    const dashboardLease = scheduler.createLease(activeContext.id, "dashboard");
    const knownRemoteWorkflowIds = new Set<number>();
    const dispatchReviews = new Map<string, {
      workflowId: number;
      ref: string;
      inputs: Record<string, string>;
      environments: readonly WorkflowEnvironmentRef[];
      expiresAt: number;
    }>();
    // Inputs of accepted dispatches whose run is not known yet, keyed by workflow, ref and acceptance time.
    const pendingDispatchInputs = new Map<string, { ref: string; inputs: Record<string, string> }>();
    const pendingDispatchKey = (workflowId: number, ref: string, acceptedAt: number) => `${workflowId}|${ref}|${acceptedAt}`;
    const dispatchInputHistory = () => new DispatchInputHistory(new RepositoryState(mementoAdapter, activeContext.id));
    const batchReviews = new Map<string, {
      items: Array<{ workflowId: number; ref: string; inputs: Record<string, string> }>;
      expiresAt: number;
    }>();
    const createJobRepository = () => new JobRepository(
      scheduler,
      activeContext,
      panelSession.accessToken,
      dashboardLease,
    );
    const createDispatchRepository = () => new DispatchRepository(
      scheduler,
      activeContext,
      panelSession.accessToken,
      dashboardLease,
    );
    const assertActiveIdentity = () => {
      if (identityGeneration !== activeGeneration) {
        dispatchReviews.clear();
        throw new AppError("authentication_required", "GitHub identity or repository selection changed. Reopen the dashboard.");
      }
    };
    const propagateElevatedSession = (elevated: vscode.AuthenticationSession, retriggerIfFailed: boolean) => {
      if (identityGeneration !== activeGeneration || elevated.account.id !== activeContext.authenticatedUserId) {
        throw new AppError("authentication_required", "GitHub identity changed. Reopen the dashboard to continue.");
      }
      panelSession = elevated;
      selectedSession = elevated;
      monitors.get(activeContext.id)?.updateToken(elevated.accessToken);
      scheduler.invalidate(activeContext.id);
      if (retriggerIfFailed && lastLoadHadInventoryOrHistoryFailure) {
        for (const refresh of panelSessionRefreshers.get(activeContext.id) ?? []) refresh(true);
      }
    };
    const elevateOnDemand = <T>(
      operation: (session: vscode.AuthenticationSession) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> => withPrivateRepositoryEscalation(
      panelSession,
      operation,
      signal,
      (elevated) => propagateElevatedSession(elevated, true),
    );
    type DashboardResult = ReturnType<typeof dashboardDataSchema.parse>;
    /** Adds what is local or specific to this tab, so cached snapshots never carry stale plans or another tab's target. */
    const withPanelFields = (result: DashboardResult, cachedAt?: number) => {
      const repoState = new RepositoryState(mementoAdapter, activeContext.id);
      const storedAudit = repoState.get<unknown[]>("autoApprovalAudit");
      const groups = readWorkflowGroups(repoState);
      const storedLayout = columnLayoutSchema.safeParse(repoState.get("columnLayout"));
      return {
        ...result,
        workflows: result.workflows.map((row) => {
          const group = groups[normalizeWorkflowPath(row.path)];
          return group ? { ...row, folder: group } : row;
        }),
        customGroups: [...new Set(Object.values(groups))].sort((a, b) => a.localeCompare(b)),
        ...(storedLayout.success ? { columnLayout: storedLayout.data } : {}),
        plans: planStore.list(activeContext.id),
        approvalRules: autoApprovalService.listRules(activeContext.id),
        approvalAudit: (Array.isArray(storedAudit) ? storedAudit : [])
          .filter((entry) => approvalAuditSchema.safeParse(entry).success)
          .slice(-50),
        ...(workflowPath ? { initialWorkflowPath: workflowPath } : {}),
        ...(initialAction ? { initialAction } : {}),
        ...(initialRunId ? { initialRunId } : {}),
        ...(initialView ? { initialView } : {}),
        ...(cachedAt !== undefined ? { cachedAt } : {}),
      };
    };
    const load = async (signal?: AbortSignal, preferCached = false) => {
      if (signal?.aborted) throw new AppError("cancelled", "Dashboard request was cancelled.");
      assertActiveIdentity();
      if (preferCached) {
        const snapshot = viewCache.getDashboard<DashboardResult>(activeContext.id, activeContext.authenticatedUserId);
        if (snapshot) {
          knownRemoteWorkflowIds.clear();
          for (const row of snapshot.value.workflows) {
            if (row.workflowId !== undefined) knownRemoteWorkflowIds.add(row.workflowId);
          }
          return withPanelFields(snapshot.value, snapshot.cachedAt);
        }
      }
      let escalationAttemptedInPass = false;
      let inventoryOrHistoryFailed = false;
      let repo = new WorkflowRepository(scheduler, activeContext, panelSession.accessToken, dashboardLease);
      let runRepo = new RunRepository(scheduler, activeContext, panelSession.accessToken, dashboardLease);
      const readInventory = async () => {
        try {
          return await repo.load(signal);
        } catch (error) {
          const classified = error instanceof AppError ? error : classifyGitHubError(error);
          if (
            classified.code !== "inaccessible" ||
            signal?.aborted ||
            escalationAttemptedInPass ||
            hasPrivateRepositoryAccess(panelSession)
          ) {
            lastLoadHadInventoryOrHistoryFailure = true;
            throw classified;
          }
          escalationAttemptedInPass = true;
          const elevated = await requestPrivateRepositoryAccess();
          if (!elevated) {
            lastLoadHadInventoryOrHistoryFailure = true;
            throw classified;
          }
          propagateElevatedSession(elevated, false);
          repo = new WorkflowRepository(scheduler, activeContext, elevated.accessToken, dashboardLease);
          runRepo = new RunRepository(scheduler, activeContext, elevated.accessToken, dashboardLease);
          try {
            return await repo.load(signal);
          } catch (retryError) {
            lastLoadHadInventoryOrHistoryFailure = true;
            throw retryError;
          }
        }
      };
      const [local, remote] = await Promise.all([
        discoverLocalWorkflows(folder, vscode.workspace.getConfiguration("actiondeck").get<string[]>("workflowFolderPrefixes", [])),
        readInventory(),
      ]);
      knownRemoteWorkflowIds.clear();
      for (const workflow of remote.workflows) knownRemoteWorkflowIds.add(workflow.id);
      assertActiveIdentity();

      let runs: Awaited<ReturnType<RunRepository["loadRecent"]>> = { runs: [], partial: false };
      let historyAccess: "access_restricted" | "auth_or_org_required" | "partial_stale" | undefined;
      try {
        runs = await runRepo.loadRecent(signal);
      } catch (error) {
        const classified = error instanceof AppError ? error : classifyGitHubError(error);
        if (classified.code === "cancelled" || signal?.aborted) throw classified;
        if (classified.code === "inaccessible" && !escalationAttemptedInPass && !hasPrivateRepositoryAccess(panelSession)) {
          escalationAttemptedInPass = true;
          const elevated = await requestPrivateRepositoryAccess();
          if (elevated) {
            propagateElevatedSession(elevated, false);
            runRepo = new RunRepository(scheduler, activeContext, elevated.accessToken, dashboardLease);
            try {
              runs = await runRepo.loadRecent(signal);
            } catch (retryError) {
              const retryFailure = retryError instanceof AppError ? retryError : classifyGitHubError(retryError);
              if (retryFailure.code === "cancelled" || signal?.aborted) throw retryFailure;
              inventoryOrHistoryFailed = true;
              historyAccess = retryFailure.code === "auth_or_org_required"
                ? "auth_or_org_required"
                : isRestrictedHistoryError(retryFailure) ? "access_restricted" : "partial_stale";
            }
          } else {
            inventoryOrHistoryFailed = true;
            historyAccess = "access_restricted";
          }
        } else {
          inventoryOrHistoryFailed = true;
          historyAccess = classified.code === "auth_or_org_required"
            ? "auth_or_org_required"
            : isRestrictedHistoryError(classified) ? "access_restricted" : "partial_stale";
        }
      }
      lastLoadHadInventoryOrHistoryFailure = inventoryOrHistoryFailed;
      assertActiveIdentity();
      const repoState = new RepositoryState(mementoAdapter, activeContext.id);
      const storedAudit = repoState.get<unknown[]>("autoApprovalAudit");
      const result = dashboardDataSchema.parse({
        ...buildDashboard(
          activeContext,
          local,
          remote.workflows,
          runs.runs,
          remote.partial || runs.partial,
          historyAccess,
          subscriptionStore.listModes(activeContext.id),
        ),
        plans: planStore.list(activeContext.id),
        approvalRules: autoApprovalService.listRules(activeContext.id),
        approvalAudit: (Array.isArray(storedAudit) ? storedAudit : [])
          .filter((entry) => approvalAuditSchema.safeParse(entry).success)
          .slice(-50),
      });
      const summaries = latestRunsByRepository.get(activeContext.id) ?? new Map<string, LatestRunSummary>();
      const availabilities = availabilityByRepository.get(activeContext.id) ?? new Map<string, string>();
      for (const row of result.workflows) {
        const normalizedPath = normalizeWorkflowPath(row.path);
        availabilities.set(normalizedPath, row.availability);
        if (row.latestRunId !== undefined) {
          summaries.set(normalizedPath, {
            status: row.status.split(" / ")[0] ?? row.status,
            conclusion: row.latestConclusion ?? null,
            ...(row.latestRunAt ? { updatedAt: row.latestRunAt } : {}),
          });
        }
      }
      latestRunsByRepository.set(activeContext.id, summaries);
      availabilityByRepository.set(activeContext.id, availabilities);
      refreshLatestRunViews();
      viewCache.setDashboard(activeContext.id, activeContext.authenticatedUserId, result, runs.runs);
      return withPanelFields(result);
    };
    /** Finished run attempts never change, so their job details are served from the shared cache. */
    const inspectRunCached = async (runId: number, attempt: number | undefined, signal?: AbortSignal) => {
      const cached = viewCache.getInspection(activeContext.id, runId, attempt);
      if (cached) return cached;
      const result = await elevateOnDemand(
        (session) => inspectRun(
          new JobRepository(scheduler, activeContext, session.accessToken, dashboardLease),
          runId,
          attempt,
          signal,
        ),
        signal,
      );
      assertActiveIdentity();
      viewCache.putInspection(activeContext.id, result, attempt);
      return result;
    };
    const panel = createDashboardPanel(context, {
      "dashboard.load": (payload, signal) => load(signal, payload.cached === true),
      "workflow.history.load": async (payload, signal) => {
        assertActiveIdentity();
        const workflowId = Number(payload.workflowId);
        const page = payload.page === undefined ? 1 : Number(payload.page);
        if (!knownRemoteWorkflowIds.has(workflowId)) {
          throw new AppError("not_found", "The requested workflow is not part of the selected repository.");
        }
        if (payload.cached === true) {
          const cachedHistory = viewCache.getHistory(activeContext.id, workflowId);
          if (cachedHistory) return historyResponse(cachedHistory, true);
        }
        if (!viewCache.canLoadHistoryPage(activeContext.id, workflowId, page)) {
          throw new AppError("invalid_input", "Workflow history pages must be loaded in order.");
        }
        const history = await elevateOnDemand(
          (session) => new RunRepository(scheduler, activeContext, session.accessToken, dashboardLease).loadHistory(
            workflowId,
            page,
            signal,
          ),
          signal,
        );
        assertActiveIdentity();
        if (!knownRemoteWorkflowIds.has(workflowId)) {
          throw new AppError("stale", "Workflow inventory changed while loading history.");
        }
        return historyResponse(viewCache.putHistoryPage(activeContext.id, workflowId, page, history), false);
      },
      "run.inspect": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = runInspectPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Run inspection request is invalid.");
        try {
          const inspection = await inspectRunCached(parsed.data.runId, parsed.data.attempt, signal);
          const recorded = dispatchInputHistory().get(parsed.data.runId);
          return recorded ? { ...inspection, dispatchInputs: recorded.inputs } : inspection;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw classifyGitHubError(error);
        }
      },
      "run.logs.load": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = runLogsPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Run log request is invalid.");
        const { runId, attempt, jobId, stepNumber } = parsed.data;
        try {
          const cachedLog = viewCache.getLog(activeContext.id, runId, attempt, jobId, stepNumber);
          if (cachedLog) return cachedLog;
          const inspection = await inspectRunCached(runId, attempt, signal);
          const job = inspection.jobs.find((candidate) => candidate.id === jobId);
          if (!job) {
            throw new AppError("invalid_input", "The selected job does not belong to this run attempt.");
          }
          const excerpt = await elevateOnDemand(
            (session) => loadJobLogProjection(
              new JobRepository(scheduler, activeContext, session.accessToken, dashboardLease),
              job,
              stepNumber,
              signal,
            ),
            signal,
          );
          assertActiveIdentity();
          viewCache.putLog(activeContext.id, runId, job.status === "completed", excerpt, stepNumber);
          return excerpt;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw classifyGitHubError(error);
        }
      },
      "run.action": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = runActionPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Run action request is invalid.");
        const { action, runId, attempt } = parsed.data;
        const authorization = new UiAuthorization();
        authorization.authorize({
          repositoryId: activeContext.id,
          target: `${action}:run:${runId}:attempt:${attempt}`,
          ref: "",
          inputs: {},
        });
        const client = createGitHubClient(
          panelSession.accessToken,
          (retryAfter) => scheduler.defer(activeContext.id, retryAfter * 1000),
        );
        const result = await scheduler.schedule(
          activeContext.id,
          `run-action:${randomUUID()}`,
          () => executeRunAction(
            client,
            activeContext,
            authorization,
            { action, runId, attempt },
            signal,
          ),
          { lease: dashboardLease },
        );
        if (result.state === "accepted") {
          scheduler.invalidate(activeContext.id);
          viewCache.invalidateRun(activeContext.id, runId);
        }
        assertActiveIdentity();
        return result;
      },
      "run.investigate": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = runInvestigatePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Run investigation request is invalid.");
        const result = await runFailureInvestigation({
          context: activeContext,
          scheduler,
          workflowId: parsed.data.workflowId,
          runId: parsed.data.runId,
          attempt: parsed.data.attempt,
          jobId: parsed.data.jobId,
          ...(parsed.data.stepNumber !== undefined ? { stepNumber: parsed.data.stepNumber } : {}),
          ref: parsed.data.ref,
          ...(signal ? { signal } : {}),
        });
        assertActiveIdentity();
        if (parsed.data.presentation === "editor") {
          const document = await vscode.workspace.openTextDocument({ language: "markdown", content: result.markdown });
          await vscode.window.showTextDocument(document, { preview: true });
        }
        return result;
      },
      "run.openChat": async (payload) => {
        assertActiveIdentity();
        const parsed = runOpenChatPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Copilot Chat request is invalid.");
        const { stepNumber, jobName, stepName, workflowPath, ...target } = parsed.data;
        const opened = await openRunInCopilotChat(activeContext, {
          ...target,
          ...(stepNumber !== undefined ? { stepNumber } : {}),
          ...(jobName !== undefined ? { jobName } : {}),
          ...(stepName !== undefined ? { stepName } : {}),
          ...(workflowPath !== undefined ? { workflowPath } : {}),
        });
        return { opened };
      },
      "plan.explainBlocked": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = planExplainBlockedPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Plan explanation request is invalid.");
        const plan = planStore.get(activeContext.id, parsed.data.planId);
        if (!plan) throw new AppError("not_found", "Release plan was not found.");
        const explanation = await explainBlockedPlan(plan, createVsCodeLanguageModelAdapter(), signal);
        assertActiveIdentity();
        return explanation;
      },
      "workflow.proposeFix": async (payload) => {
        assertActiveIdentity();
        const parsed = workflowProposeFixPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Workflow fix proposal request is invalid.");
        if (!proposalProvider) {
          throw new AppError("service", "Workflow diff provider is not registered.");
        }
        const targetUri = vscode.Uri.joinPath(folder.uri, ...parsed.data.workflowPath.split("/"));
        const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === targetUri.toString());
        const source = openDoc
          ? openDoc.getText()
          : new TextDecoder().decode(await vscode.workspace.fs.readFile(targetUri));
        const proposal = proposeCommentPreservingYamlFix(
          source,
          parsed.data.setAtPath
            ? { setAtPath: parsed.data.setAtPath }
            : { setAtPath: { path: ["permissions"], value: "read-all" } },
        );
        if (!proposal.changed) return { changed: false, applied: false };
        const diff = await openWorkflowFixDiff({
          provider: proposalProvider,
          workspaceFolderUri: activeContext.workspaceFolderUri,
          workflowPath: parsed.data.workflowPath,
          proposedContent: proposal.content,
        });
        return { changed: true, applied: diff.applied };
      },
      "repository.branches": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = repositoryBranchesPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Branch list request is invalid.");
        const userId = activeContext.authenticatedUserId;
        // The checked-out branch is read fresh on every call; only remote names are cached.
        const withCurrent = <T extends { names: readonly string[]; truncated: boolean }>(value: T) => {
          const current = currentWorkspaceBranch(activeContext.workspaceFolderUri, activeContext.remoteName);
          return current && (value.names.includes(current) || value.truncated) ? { ...value, current } : value;
        };
        const cached = parsed.data.refresh ? undefined : viewCache.getBranches(activeContext.id, userId);
        if (cached) return withCurrent({ ...cached.value, cachedAt: cached.cachedAt });
        try {
          const branches = await elevateOnDemand(
            (session) => new DispatchRepository(scheduler, activeContext, session.accessToken, dashboardLease).listBranches(signal),
            signal,
          );
          assertActiveIdentity();
          const stored = viewCache.setBranches(activeContext.id, userId, branches);
          return withCurrent({ ...stored.value, cachedAt: stored.cachedAt });
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw classifyGitHubError(error);
        }
      },
      "dispatch.validate": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = dispatchValidatePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Dispatch validation request is invalid.");
        try {
          const target = await elevateOnDemand(
            (session) => new DispatchRepository(scheduler, activeContext, session.accessToken, dashboardLease).loadTarget(
              parsed.data.workflowId,
              parsed.data.ref ?? "",
              signal,
            ),
            signal,
          );
          assertActiveIdentity();
          if (target.state !== "available") {
            return {
              target,
              validation: { valid: false, values: {}, errors: { _form: target.reason } },
            };
          }
          const validation = validateRemoteDispatchInputs(target, parsed.data.inputs);
          const environmentInventory = target.inputs.some((input) => input.type === "environment")
            ? await createDispatchRepository().listEnvironments(signal)
            : undefined;
          assertActiveIdentity();
          for (const [token, review] of dispatchReviews) {
            if (review.expiresAt <= Date.now()) dispatchReviews.delete(token);
          }
          let reviewToken: string | undefined;
          if (validation.valid && parsed.data.review === true) {
            reviewToken = randomUUID();
            dispatchReviews.set(reviewToken, {
              workflowId: target.workflowId,
              ref: target.ref,
              inputs: { ...validation.values },
              environments: target.environments ?? [],
              expiresAt: Date.now() + 60_000,
            });
          }
          while (dispatchReviews.size > 32) {
            const oldest = dispatchReviews.keys().next().value as string | undefined;
            if (!oldest) break;
            dispatchReviews.delete(oldest);
          }
          return {
            target,
            validation,
            ...(reviewToken ? { reviewToken } : {}),
            ...(environmentInventory ? { environmentInventory } : {}),
          };
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw classifyGitHubError(error);
        }
      },
      "dispatch.submit": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = dispatchSubmitPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Dispatch submission request is invalid.");
        const review = dispatchReviews.get(parsed.data.reviewToken);
        dispatchReviews.delete(parsed.data.reviewToken);
        if (
          !review ||
          review.expiresAt <= Date.now() ||
          review.workflowId !== parsed.data.workflowId ||
          review.ref !== parsed.data.ref ||
          !sameInputValues(review.inputs, parsed.data.inputs)
        ) {
          throw new AppError("permission_restricted", "Dispatch review is missing, expired, or no longer matches these inputs.");
        }
        const authorization = new UiAuthorization();
        authorization.authorize({
          repositoryId: activeContext.id,
          target: `workflow:${review.workflowId}`,
          ref: review.ref,
          inputs: review.inputs,
        });
        const autoApprovalScope = parsed.data.autoApproveEnvironments
          ? resolveAutoApprovalScope(review.environments, review.inputs)
          : undefined;
        if (autoApprovalScope && review.environments.length === 0) {
          throw new AppError("invalid_input", "This workflow declares no deployment environments to auto-approve.");
        }
        const repository = createDispatchRepository();
        const submittedAt = Date.now();
        const { autoApproveEnvironments: _optIn, ...dispatchRequest } = parsed.data;
        const result = await executeDispatch(
          repository,
          activeContext,
          authorization,
          dispatchRequest,
          undefined,
          signal,
        );
        scheduler.invalidate(activeContext.id);
        assertActiveIdentity();
        if (result.state === "associated_run_found" || result.state === "completed") {
          await dispatchInputHistory().record(result.runId, review.ref, review.inputs);
        } else if (result.state === "request_accepted") {
          pendingDispatchInputs.set(pendingDispatchKey(review.workflowId, review.ref, result.acceptedAt), {
            ref: review.ref,
            inputs: review.inputs,
          });
          while (pendingDispatchInputs.size > 32) {
            const oldest = pendingDispatchInputs.keys().next().value as string | undefined;
            if (!oldest) break;
            pendingDispatchInputs.delete(oldest);
          }
        }
        if (!autoApprovalScope) return result;
        // The grant is only recorded once GitHub accepted the dispatch; an uncertain outcome gets none.
        if (result.state === "request_accepted") {
          await runApprovalGrants.grant(activeContext, {
            workflowId: review.workflowId,
            ref: review.ref,
            environments: autoApprovalScope.environments,
            submittedAt: result.submittedAt,
            acceptedAt: result.acceptedAt,
          });
        } else if (result.state === "associated_run_found") {
          await runApprovalGrants.grant(activeContext, {
            workflowId: review.workflowId,
            ref: review.ref,
            environments: autoApprovalScope.environments,
            submittedAt,
            acceptedAt: Date.now(),
            runId: result.runId,
          });
        } else {
          return result;
        }
        return { ...result, autoApproval: autoApprovalScope };
      },
      "dispatch.association": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = dispatchAssociationPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Dispatch association request is invalid.");
        try {
          const result = await checkDispatchAssociation(
            createDispatchRepository(),
            activeContext,
            parsed.data,
            signal,
          );
          assertActiveIdentity();
          if (result.state === "associated_run_found" || result.state === "completed") {
            const key = pendingDispatchKey(parsed.data.workflowId, parsed.data.ref, parsed.data.acceptedAt);
            const pending = pendingDispatchInputs.get(key);
            if (pending) {
              pendingDispatchInputs.delete(key);
              await dispatchInputHistory().record(result.runId, pending.ref, pending.inputs);
            }
          }
          return result;
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw classifyGitHubError(error);
        }
      },
      "batch.validate": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = batchValidatePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Batch validation request is invalid.");
        const loadedTargets = await elevateOnDemand(
          (session) => {
            const repository = new DispatchRepository(scheduler, activeContext, session.accessToken, dashboardLease);
            return Promise.all(
              parsed.data.items.map((item) => repository.loadTarget(item.workflowId, item.ref ?? "", signal)),
            );
          },
          signal,
        );
        assertActiveIdentity();
        const compatibility = analyzeBatchInputCompatibility(loadedTargets);
        const perWorkflowOverrides: Record<number, Record<string, string>> = {};
        for (const [id, vals] of Object.entries(parsed.data.perWorkflowOverrides ?? {})) {
          perWorkflowOverrides[Number(id)] = vals;
        }
        let resolvedItems;
        try {
          resolvedItems = resolveBatchTargets(loadedTargets, {
            sharedInputs: parsed.data.sharedInputs,
            defaultDecisions: parsed.data.defaultDecisions,
            perWorkflowOverrides,
          });
        } catch (error) {
          throw new AppError("invalid_input", error instanceof Error ? error.message : String(error));
        }
        const valid = resolvedItems.every((item) => item.valid);
        let reviewToken: string | undefined;
        if (valid) {
          reviewToken = randomUUID();
          batchReviews.set(reviewToken, {
            items: resolvedItems.map((item) => ({
              workflowId: item.workflowId,
              ref: item.ref,
              inputs: { ...item.effectiveInputs },
            })),
            expiresAt: Date.now() + 60_000,
          });
        }
        return {
          valid,
          ...(reviewToken ? { reviewToken } : {}),
          compatibility,
          resolvedItems,
        };
      },
      "batch.submit": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = batchSubmitPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Batch submission request is invalid.");
        const review = batchReviews.get(parsed.data.reviewToken);
        batchReviews.delete(parsed.data.reviewToken);
        if (
          !review ||
          review.expiresAt <= Date.now() ||
          review.items.length !== parsed.data.items.length ||
          review.items.some((expected, idx) => {
            const actual = parsed.data.items[idx];
            return !actual ||
              expected.workflowId !== actual.workflowId ||
              expected.ref !== actual.ref ||
              !sameInputValues(expected.inputs, actual.inputs);
          })
        ) {
          throw new AppError("permission_restricted", "Batch review is missing, expired, or no longer matches these targets.");
        }
        const authorization = new UiAuthorization();
        authorization.authorize({
          repositoryId: activeContext.id,
          target: `batch:${review.items.map((item) => item.workflowId).join(",")}`,
          ref: review.items[0]?.ref ?? "",
          inputs: { count: String(review.items.length) },
        });
        const result = await executeBatchDispatch(
          createDispatchRepository(),
          activeContext,
          authorization,
          review.items,
          { concurrency: 3, ...(signal ? { signal } : {}) },
        );
        scheduler.invalidate(activeContext.id);
        assertActiveIdentity();
        return result;
      },
      "plan.save": async (payload) => {
        assertActiveIdentity();
        const parsed = planSavePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Release plan payload is invalid.");
        const plan = {
          id: parsed.data.id,
          name: parsed.data.name,
          repositoryId: activeContext.id,
          state: parsed.data.schedule ? ("scheduled" as const) : ("draft" as const),
          steps: parsed.data.steps.map(({ autoApprove, ...step }) => ({
            ...step,
            ...(autoApprove ? { autoApprove } : {}),
            state: "pending" as const,
          })),
          currentStepIndex: 0,
          ...(parsed.data.schedule
            ? {
              schedule: {
                kind: parsed.data.schedule.kind,
                runAtMs: parsed.data.schedule.runAtMs,
                ...(parsed.data.schedule.delayMs !== undefined ? { delayMs: parsed.data.schedule.delayMs } : {}),
                timeZone: parsed.data.schedule.timeZone,
              },
            }
            : {}),
          updatedAt: Date.now(),
        };
        const scheduled = localPlanScheduler.scheduleOrDetectMissed(plan);
        return planService.savePlan(scheduled);
      },
      "plan.start": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = planControlPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Plan start request is invalid.");
        return planService.startPlan(
          createDispatchRepository(),
          activeContext,
          parsed.data.planId,
          parsed.data.runtimeInputs,
          signal,
        );
      },
      "plan.pause": async (payload) => {
        assertActiveIdentity();
        const parsed = planControlPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Plan pause request is invalid.");
        localPlanScheduler.clearTimer(parsed.data.planId);
        return planService.pausePlan(activeContext.id, parsed.data.planId);
      },
      "plan.resume": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = planControlPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Plan resume request is invalid.");
        const existing = planStore.get(activeContext.id, parsed.data.planId);
        if (existing?.state === "missed_schedule") {
          const resumed = await localPlanScheduler.resumeMissedSchedule(
            activeContext.id,
            parsed.data.planId,
            parsed.data.runtimeInputs,
          );
          return planService.startPlan(
            createDispatchRepository(),
            activeContext,
            resumed.id,
            parsed.data.runtimeInputs,
            signal,
          );
        }
        return planService.resumePlan(
          createDispatchRepository(),
          activeContext,
          parsed.data.planId,
          parsed.data.runtimeInputs,
          signal,
        );
      },
      "plan.stop": async (payload) => {
        assertActiveIdentity();
        const parsed = planControlPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Plan stop request is invalid.");
        localPlanScheduler.clearTimer(parsed.data.planId);
        return planService.stopPlan(activeContext.id, parsed.data.planId);
      },
      "subscription.update": async (payload) => {
        assertActiveIdentity();
        const parsed = subscriptionUpdatePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Subscription update request is invalid.");
        await subscriptionStore.setWorkflowMode(activeContext.id, parsed.data.workflowId, parsed.data.mode);
        return { workflowId: parsed.data.workflowId, mode: parsed.data.mode };
      },
      "deployment.list": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = deploymentListPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Deployment list request is invalid.");
        const environments = await elevateOnDemand(
          (session) => new DeploymentRepository(scheduler, activeContext, session.accessToken, dashboardLease)
            .listPendingDeployments(parsed.data.runId, signal),
          signal,
        );
        return { runId: parsed.data.runId, environments };
      },
      "deployment.review": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = deploymentReviewPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Deployment review request is invalid.");
        const authorization = new UiAuthorization();
        authorization.authorize({
          repositoryId: activeContext.id,
          target: `review:run:${parsed.data.runId}:envs:${parsed.data.environmentIds.join(",")}`,
          ref: parsed.data.state,
          inputs: { comment: parsed.data.comment ?? "" },
        });
        const repo = new DeploymentRepository(scheduler, activeContext, panelSession.accessToken, dashboardLease);
        return reviewPendingDeployments(repo, activeContext, authorization, {
          runId: parsed.data.runId,
          environmentIds: parsed.data.environmentIds,
          state: parsed.data.state,
          ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
        }, signal);
      },
      "approvalRule.save": async (payload) => {
        assertActiveIdentity();
        const parsed = approvalRuleSavePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Approval rule payload is invalid.");
        if (!activeContext.authenticatedUserId) {
          throw new AppError("authentication_required", "Authenticated user identity is required.");
        }
        return autoApprovalService.saveRule({
          id: parsed.data.id,
          repositoryId: activeContext.id,
          workflowId: parsed.data.workflowId,
          environmentName: parsed.data.environmentName,
          ref: parsed.data.ref,
          authenticatedUserId: activeContext.authenticatedUserId,
          enabled: false,
          createdAt: Date.now(),
        });
      },
      "approvalRule.setEnabled": async (payload) => {
        assertActiveIdentity();
        const parsed = approvalRuleSetEnabledPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Approval rule toggle request is invalid.");
        return autoApprovalService.setRuleEnabled(activeContext.id, parsed.data.ruleId, parsed.data.enabled);
      },
      "workflow.setGroup": async (payload) => {
        assertActiveIdentity();
        const parsed = workflowSetGroupPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Group request is invalid.");
        const repoState = new RepositoryState(mementoAdapter, activeContext.id);
        const groups = { ...readWorkflowGroups(repoState) };
        for (const path of parsed.data.workflowPaths) {
          const key = normalizeWorkflowPath(path);
          if (parsed.data.group === null) delete groups[key];
          else groups[key] = parsed.data.group;
        }
        await repoState.update("workflowGroups", groups);
        return { groups };
      },
      "dashboard.saveColumns": async (payload) => {
        const parsed = columnLayoutSavePayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Column layout is invalid.");
        await new RepositoryState(mementoAdapter, activeContext.id).update("columnLayout", parsed.data.layout);
        return { saved: true };
      },
      "settings.cachedCards": async () => {
        assertActiveIdentity();
        return { cards: viewCache.getSettings(activeContext.id, activeContext.authenticatedUserId) };
      },
      "settings.loadCard": async (payload, signal) => {
        assertActiveIdentity();
        const parsed = settingsLoadCardPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Settings card request is invalid.");
        const repositoryId = activeContext.id;
        const userId = activeContext.authenticatedUserId;
        const result = await loadSettingsCard({
          loadEnvironments: (s) => elevateOnDemand(
            (session) => new SettingsRepository(scheduler, activeContext, session.accessToken, dashboardLease).loadEnvironments(s),
            s,
          ),
          loadVariablesAndSecrets: (s) => elevateOnDemand(
            (session) => new SettingsRepository(scheduler, activeContext, session.accessToken, dashboardLease).loadVariablesAndSecrets(s),
            s,
          ),
          loadRunners: (s) => elevateOnDemand(
            (session) => new SettingsRepository(scheduler, activeContext, session.accessToken, dashboardLease).loadRunners(s),
            s,
          ),
        }, parsed.data.card, signal);
        viewCache.setSettingsCard(repositoryId, userId, result);
        return result;
      },
      "workflow.openFile": async (payload) => {
        const workflowPath = String(payload.workflowPath);
        if (!/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(workflowPath)) {
          throw new AppError("invalid_input", "Local workflow path is invalid.");
        }
        const uri = vscode.Uri.joinPath(folder.uri, ...workflowPath.split("/"));
        await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return { opened: true };
      },
      "workflow.localPreview": async (payload) => {
        assertActiveIdentity();
        const workflowPath = String(payload.workflowPath);
        if (!/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(workflowPath)) {
          throw new AppError("invalid_input", "Local workflow path is invalid.");
        }
        const uri = vscode.Uri.joinPath(folder.uri, ...workflowPath.split("/"));
        const openDocument = vscode.workspace.textDocuments.find(
          (document) => document.uri.toString() === uri.toString(),
        );
        const source = openDocument
          ? openDocument.getText()
          : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        assertActiveIdentity();
        return inspectLocalWorkflowPreview(workflowPath, source);
      },
      "repository.select": async () => {
        const previousId = selectedContext?.id;
        const next = await selectRepository();
        if (next) {
          selectedContext = next;
          if (previousId && previousId !== next.id) scheduler.invalidate(previousId);
          if (previousId !== next.id) identityGeneration++;
          selectedSession = await getGitHubSession(false);
        }
        return { selected: Boolean(next) };
      },
      "view.openInTab": async (payload) => {
        const parsed = viewOpenInTabPayload.safeParse(payload);
        if (!parsed.success) throw new AppError("invalid_input", "Tab target is invalid.");
        if (!(await selectBoundRepository(activeContext.id))) {
          throw new AppError("authentication_required", "Sign in to GitHub for this repository to open it in a tab.");
        }
        if (parsed.data.kind === "pipeline") {
          await vscode.commands.executeCommand("actiondeck.openDashboard", parsed.data.workflowPath, "pipeline");
        } else {
          await vscode.commands.executeCommand("actiondeck.openDashboard", undefined, undefined, parsed.data.runId);
        }
        return { opened: true };
      },
      "external.open": async (payload) => {
        const url = parseSupportedGitHubRunUrl(String(payload.url));
        if (!url) throw new AppError("invalid_input", "Only validated GitHub Actions run links can be opened.");
        const opened = await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
        if (!opened) throw new AppError("service", "VS Code could not open the GitHub run link.");
        return { opened: true };
      },
    }, workflowPath && initialAction !== "pipeline" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
    // Each entry point opens its own tab; name it after the surface it shows.
    const workflowFile = workflowPath ? posix.basename(workflowPath) : undefined;
    panel.title = initialRunId ? `Run #${initialRunId}`
      : initialView === "action-center" ? "Action Center"
      : workflowFile && initialAction === "latest-run" ? `Latest run · ${workflowFile}`
      : workflowFile && initialAction === "pipeline" ? `Pipeline · ${workflowFile}`
      : workflowFile ? `Companion · ${workflowFile}`
      : "ActionDeck";
    const refreshPanelSession = (retriggerDashboard = lastLoadHadInventoryOrHistoryFailure) => {
      const session = selectedSession;
      if (!session || session.account.id !== activeContext.authenticatedUserId) return;
      panelSession = session;
      activeGeneration = identityGeneration;
      dispatchReviews.clear();
      if (!retriggerDashboard) return;
      void Promise.resolve(panel.webview.postMessage(hostEvent(randomUUID(), "repository.session.changed", {
        repository: { owner: activeContext.owner, repo: activeContext.repo },
      }))).then((delivered) => {
        if (!delivered) console.warn("ActionDeck could not deliver a refreshed session event.");
      }).catch((error: unknown) => console.error("ActionDeck session refresh failed", error));
    };
    const refreshers = panelSessionRefreshers.get(activeContext.id) ?? new Set();
    refreshers.add(refreshPanelSession);
    panelSessionRefreshers.set(activeContext.id, refreshers);
    const postPanelEvent = (event: string, payload: unknown) => {
      void Promise.resolve(panel.webview.postMessage(hostEvent(randomUUID(), event, payload)))
        .catch((error: unknown) => console.error(`ActionDeck could not deliver ${event}`, error));
    };
    const observePlan = (plan: ReleasePlan) => {
      if (plan.repositoryId !== activeContext.id || identityGeneration !== activeGeneration) return;
      postPanelEvent("plan.updated", { plan });
    };
    planObservers.add(observePlan);
    const observeRuns = (runs: readonly WorkflowRunRecord[]) => {
      if (identityGeneration !== activeGeneration) return;
      const patches = latestRunPatches(activeContext, runs);
      if (patches.length === 0) return;
      postPanelEvent("runs.observed", {
        repository: { owner: activeContext.owner, repo: activeContext.repo },
        runs: patches,
      });
    };
    const panelRunObservers = runObservers.get(activeContext.id) ?? new Set();
    panelRunObservers.add(observeRuns);
    runObservers.set(activeContext.id, panelRunObservers);
    const localWorkflowWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".github/workflows/*"),
    );
    let localChangesPending = false;
    let previewChangesPending = false;
    const sendLocalChange = () => {
      if (identityGeneration !== activeGeneration) return;
      localChangesPending = true;
      if (!panel.visible) return;
      localChangesPending = false;
      void Promise.resolve(panel.webview.postMessage(hostEvent(randomUUID(), "workflows.changed", {
        repository: { owner: activeContext.owner, repo: activeContext.repo },
      }))).then((delivered) => {
        if (!delivered) console.warn("ActionDeck could not deliver a local workflow refresh event.");
      }).catch((error: unknown) => console.error("ActionDeck local workflow refresh failed", error));
    };
    const localWorkflowChanges = watchWorkflowFiles(localWorkflowWatcher, sendLocalChange);
    const sendPreviewChange = () => {
      if (identityGeneration !== activeGeneration) return;
      previewChangesPending = true;
      if (!panel.visible) return;
      previewChangesPending = false;
      void Promise.resolve(panel.webview.postMessage(hostEvent(randomUUID(), "workflow.preview.changed", {
        workflowPath,
      }))).then((delivered) => {
        if (!delivered) console.warn("ActionDeck could not deliver a workflow preview refresh event.");
      }).catch((error: unknown) => console.error("ActionDeck workflow preview refresh failed", error));
    };
    const editorChanges = workflowPath
      ? vscode.workspace.onDidChangeTextDocument((event) => {
        const documentPath = posix.relative(folder.uri.path, event.document.uri.path);
        if (
          documentPath.toLowerCase() !== workflowPath.toLowerCase() ||
          event.document.uri.scheme !== folder.uri.scheme ||
          event.document.uri.authority !== folder.uri.authority ||
          identityGeneration !== activeGeneration
        ) return;
        sendPreviewChange();
      })
      : undefined;
    const viewState = panel.onDidChangeViewState((event) => {
      dashboardLease.setVisible(event.webviewPanel.visible);
      if (event.webviewPanel.visible && localChangesPending) sendLocalChange();
      if (event.webviewPanel.visible && previewChangesPending) sendPreviewChange();
    });
    const disposal = panel.onDidDispose(() => {
      dashboardLease.dispose();
      localWorkflowChanges.dispose();
      editorChanges?.dispose();
      viewState.dispose();
      refreshers.delete(refreshPanelSession);
      if (refreshers.size === 0) panelSessionRefreshers.delete(activeContext.id);
      planObservers.delete(observePlan);
      panelRunObservers.delete(observeRuns);
      if (panelRunObservers.size === 0) runObservers.delete(activeContext.id);
      disposal.dispose();
    });
  });
  const openActionCenter = vscode.commands.registerCommand("actiondeck.openActionCenter", async () => {
    const targetId = statusTicker.primaryRepositoryId() ?? selectedContext?.id;
    if (targetId && !(await selectBoundRepository(targetId))) {
      void vscode.window.showWarningMessage("Sign in to GitHub for the monitored repository to open its Action Center.");
      return;
    }
    await vscode.commands.executeCommand("actiondeck.openDashboard", undefined, undefined, undefined, "action-center");
  });
  /** Makes `choice` the selected repository without prompting; signs in if needed. */
  const selectRepositoryChoice = async (choice: RepositoryChoice): Promise<boolean> => {
    const folderUri = choice.folder.uri.toString();
    if (
      selectedContext?.workspaceFolderUri === folderUri &&
      selectedContext.remoteName === choice.remoteName &&
      selectedContext.owner === choice.owner &&
      selectedContext.repo === choice.repo &&
      selectedSession
    ) return true;
    const session = await getGitHubSession(true);
    if (!session) return false;
    const next = createRepositoryContext(folderUri, choice.remoteName, choice.owner, choice.repo, session.account.id);
    const previousId = selectedContext?.id;
    selectedContext = next;
    selectedSession = session;
    if (previousId && previousId !== next.id) scheduler.invalidate(previousId);
    if (previousId !== next.id) identityGeneration++;
    return true;
  };
  const openWorkflowFromEditor = async (
    target?: vscode.Uri | WorkspaceTreeNode,
    action: WorkflowEditorAction = "companion",
  ) => {
    const node = isWorkspaceTreeNode(target) && target.kind === "workflow" ? target : undefined;
    const uri = node ? node.uri : target instanceof vscode.Uri ? target : undefined;
    const candidates = [
      uri?.path ? { uri } : undefined,
      vscode.window.activeTextEditor?.document,
      ...vscode.window.visibleTextEditors.map((editor) => editor.document),
    ];
    const document = candidates.find((item) => item && isWorkflowDocument(item));
    if (!document) {
      void vscode.window.showInformationMessage("Open a GitHub workflow YAML file to use the ActionDeck Companion.");
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || folder.uri.scheme !== document.uri.scheme || folder.uri.authority !== document.uri.authority) {
      void vscode.window.showErrorMessage("The active workflow file is not inside a selected workspace folder.");
      return;
    }
    const workflowPath = posix.relative(folder.uri.path, document.uri.path);
    if (!/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(workflowPath)) {
      void vscode.window.showErrorMessage("The active file is not under .github/workflows.");
      return;
    }
    if (node) {
      if (!(await selectRepositoryChoice(node.choice))) return;
    } else if (selectedContext?.workspaceFolderUri !== folder.uri.toString()) {
      // A folder with exactly one GitHub remote needs no prompt.
      const folderRepositories = discoverWorkspaceRepositories().filter((item) => item.folder.uri.toString() === folder.uri.toString());
      const only = folderRepositories.length === 1 ? folderRepositories[0] : undefined;
      if (only) {
        if (!(await selectRepositoryChoice(only))) return;
      } else {
        const previousId = selectedContext?.id;
        const next = await selectRepository();
        if (!next) return;
        if (next.workspaceFolderUri !== folder.uri.toString()) {
          void vscode.window.showErrorMessage("Select a GitHub remote from the workspace folder containing this workflow.");
          return;
        }
        selectedContext = next;
        if (previousId && selectedContext.id !== previousId) scheduler.invalidate(previousId);
        if (selectedContext.id !== previousId) identityGeneration++;
        selectedSession = await getGitHubSession(false);
      }
    }
    await vscode.commands.executeCommand("actiondeck.openDashboard", workflowPath, action);
  };
  const openCompanion = vscode.commands.registerCommand(
    "actiondeck.openCompanion",
    (target?: vscode.Uri | WorkspaceTreeNode) => openWorkflowFromEditor(target, "companion"),
  );
  const openLatestRun = vscode.commands.registerCommand(
    "actiondeck.openLatestWorkflowRun",
    (target?: vscode.Uri | WorkspaceTreeNode) => openWorkflowFromEditor(target, "latest-run"),
  );
  const openPipeline = vscode.commands.registerCommand(
    "actiondeck.openPipeline",
    (target?: vscode.Uri | WorkspaceTreeNode) => openWorkflowFromEditor(target, "pipeline"),
  );
  const openRepositoryDeck = vscode.commands.registerCommand(
    "actiondeck.openRepositoryDeck",
    async (target?: WorkspaceTreeNode) => {
      if (!isWorkspaceTreeNode(target) || target.kind === "pinned-group") {
        await vscode.commands.executeCommand("actiondeck.openDashboard");
        return;
      }
      if (await selectRepositoryChoice(target.choice)) await vscode.commands.executeCommand("actiondeck.openDashboard");
    },
  );
  const openWorkflowFile = vscode.commands.registerCommand(
    "actiondeck.openWorkflowFile",
    async (target?: WorkspaceTreeNode) => {
      if (isWorkspaceTreeNode(target) && target.kind === "workflow") await vscode.window.showTextDocument(target.uri);
    },
  );
  const pinWorkflow = vscode.commands.registerCommand(
    "actiondeck.pinWorkflow",
    async (target?: WorkspaceTreeNode) => {
      if (!isWorkspaceTreeNode(target) || target.kind !== "workflow") return;
      if (await launcherState.pinWorkflow(repositoryNodeId(target.choice), target.workflowPath)) {
        workspaceTree.refresh();
      }
    },
  );
  const unpinWorkflow = vscode.commands.registerCommand(
    "actiondeck.unpinWorkflow",
    async (target?: WorkspaceTreeNode) => {
      if (!isWorkspaceTreeNode(target) || target.kind !== "workflow") return;
      if (await launcherState.unpinWorkflow(repositoryNodeId(target.choice), target.workflowPath)) {
        workspaceTree.refresh();
      }
    },
  );
  const moveRepositoryUp = vscode.commands.registerCommand(
    "actiondeck.moveRepositoryUp",
    async (target?: WorkspaceTreeNode) => {
      if (!isWorkspaceTreeNode(target) || target.kind !== "repository") return;
      const moved = await launcherState.moveRepository(
        repositoryNodeId(target.choice),
        "up",
        workspaceTree.getVisibleRepositoryIds(),
      );
      if (moved) workspaceTree.refresh();
    },
  );
  const moveRepositoryDown = vscode.commands.registerCommand(
    "actiondeck.moveRepositoryDown",
    async (target?: WorkspaceTreeNode) => {
      if (!isWorkspaceTreeNode(target) || target.kind !== "repository") return;
      const moved = await launcherState.moveRepository(
        repositoryNodeId(target.choice),
        "down",
        workspaceTree.getVisibleRepositoryIds(),
      );
      if (moved) workspaceTree.refresh();
    },
  );
  const sortWorkspaceTree = vscode.commands.registerCommand("actiondeck.sortWorkspaceTree", async () => {
    const current = launcherState.load();
    type SortPickItem = vscode.QuickPickItem & {
      readonly group?: "repo" | "workflow";
      readonly value?: RepositorySortOrder | WorkflowSortOrder;
    };
    const mark = (active: boolean) => (active ? "$(check) " : "     ");
    const items: SortPickItem[] = [
      { label: "Repositories", kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(current.repositorySort === "name-asc")}Name (A → Z)`, group: "repo", value: "name-asc" },
      { label: `${mark(current.repositorySort === "name-desc")}Name (Z → A)`, group: "repo", value: "name-desc" },
      {
        label: `${mark(current.repositorySort === "manual")}Custom Order`,
        description: "Drag repositories or use Move Up / Move Down",
        group: "repo",
        value: "manual",
      },
      { label: "Workflows", kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(current.workflowSort === "name-asc")}Name (A → Z)`, group: "workflow", value: "name-asc" },
      { label: `${mark(current.workflowSort === "name-desc")}Name (Z → A)`, group: "workflow", value: "name-desc" },
      {
        label: `${mark(current.workflowSort === "recent")}Recently Run`,
        description: "Most recently updated runs first",
        group: "workflow",
        value: "recent",
      },
      {
        label: `${mark(current.workflowSort === "status")}Status`,
        description: "Failures and running workflows first",
        group: "workflow",
        value: "status",
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Sort ActionDeck Sidebar",
      placeHolder: "Choose repository or workflow sort order",
    });
    if (!picked?.group || !picked.value) return;
    if (picked.group === "repo") {
      await launcherState.setRepositorySort(picked.value as RepositorySortOrder);
    } else {
      await launcherState.setWorkflowSort(picked.value as WorkflowSortOrder);
    }
    workspaceTree.refresh();
  });
  const searchPipelines = vscode.commands.registerCommand("actiondeck.searchPipelines", async () => {
    const allWorkflows = await workspaceTree.listAllWorkflows();
    if (allWorkflows.length === 0) {
      void vscode.window.showInformationMessage("No workflows were found in the current workspace.");
      return;
    }

    type PipelinePickItem = vscode.QuickPickItem & { readonly node?: WorkflowTreeNode };
    const pinBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("pin"), tooltip: "Pin Workflow" };
    const unpinBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("pinned"), tooltip: "Unpin Workflow" };
    const latestRunBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("history"), tooltip: "Open Latest Run" };
    const openFileBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("go-to-file"), tooltip: "Open Workflow File" };

    const buildItems = (): PipelinePickItem[] => {
      const pinnedItems: PipelinePickItem[] = [];
      const otherItems: PipelinePickItem[] = [];
      for (const node of allWorkflows) {
        const repoId = repositoryNodeId(node.choice);
        const pinned = launcherState.isPinned(repoId, node.workflowPath);
        const latest = lookupLatestRunForChoice(node.choice, node.workflowPath);
        const runText = latest ? latestRunLabel(latest) : undefined;
        const item: PipelinePickItem = {
          label: `${pinned ? "$(pinned) " : "$(play) "}${node.name}`,
          description: `${node.choice.owner}/${node.choice.repo}`,
          detail: runText ? `${node.workflowPath} · ${runText}` : node.workflowPath,
          buttons: [pinned ? unpinBtn : pinBtn, latestRunBtn, openFileBtn],
          node,
        };
        if (pinned) {
          pinnedItems.push(item);
        } else {
          otherItems.push(item);
        }
      }
      if (pinnedItems.length === 0) return otherItems;
      return [
        { label: "Pinned", kind: vscode.QuickPickItemKind.Separator },
        ...pinnedItems,
        { label: "All Workflows", kind: vscode.QuickPickItemKind.Separator },
        ...otherItems,
      ];
    };

    const picker = vscode.window.createQuickPick<PipelinePickItem>();
    picker.title = "Search Pipelines";
    picker.placeholder = "Filter by workflow name, repository, or file path...";
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = buildItems();

    picker.onDidTriggerItemButton(async (event) => {
      const node = event.item.node;
      if (!node) return;
      if (event.button === pinBtn) {
        await launcherState.pinWorkflow(repositoryNodeId(node.choice), node.workflowPath);
        workspaceTree.refresh();
        picker.items = buildItems();
        return;
      }
      if (event.button === unpinBtn) {
        await launcherState.unpinWorkflow(repositoryNodeId(node.choice), node.workflowPath);
        workspaceTree.refresh();
        picker.items = buildItems();
        return;
      }
      picker.hide();
      if (event.button === latestRunBtn) {
        await vscode.commands.executeCommand("actiondeck.openLatestWorkflowRun", node);
      } else if (event.button === openFileBtn) {
        await vscode.commands.executeCommand("actiondeck.openWorkflowFile", node);
      }
    });

    picker.onDidAccept(async () => {
      const selected = picker.selectedItems[0]?.node;
      picker.hide();
      if (selected) {
        await vscode.commands.executeCommand("actiondeck.openPipeline", selected);
      }
    });

    picker.onDidHide(() => picker.dispose());
    picker.show();
  });
  const refreshTree = vscode.commands.registerCommand("actiondeck.refreshWorkspaceTree", () => workspaceTree.refresh());
  const codeLens = vscode.languages.registerCodeLensProvider(
    { pattern: WORKFLOW_FILE_PATTERN },
    codeLensProvider,
  );
  const launcherView = typeof vscode.window.createTreeView === "function"
    ? vscode.window.createTreeView("actiondeck.launcher", {
      treeDataProvider: workspaceTree,
      dragAndDropController: workspaceTree,
      showCollapseAll: true,
    })
    : typeof vscode.window.registerTreeDataProvider === "function"
      ? vscode.window.registerTreeDataProvider("actiondeck.launcher", workspaceTree)
      : { dispose() {} };
  const workflowFilesWatcher = typeof vscode.workspace.createFileSystemWatcher === "function"
    ? vscode.workspace.createFileSystemWatcher(WORKFLOW_FILE_PATTERN, false, true, false)
    : undefined;
  workflowFilesWatcher?.onDidCreate(() => workspaceTree.refresh());
  workflowFilesWatcher?.onDidDelete(() => workspaceTree.refresh());
  const repositoriesChanged = onDidChangeWorkspaceRepositories(() => workspaceTree.refresh());
  const sessionChange = vscode.authentication.onDidChangeSessions(async (event) => {
    if (event.provider.id !== "github") return;
    const currentSession = await getGitHubSession(false);
    for (const bound of [...boundContexts.values()]) {
      const expectedUserId = bound.authenticatedUserId;
      if (!expectedUserId) continue;
      scheduler.invalidate(bound.id);
      const isSelected = selectedContext?.id === bound.id;
      if (currentSession?.account.id !== expectedUserId) {
        disposeMonitor(bound.id);
        for (const plan of planStore.list(bound.id)) localPlanScheduler.clearTimer(plan.id);
        notificationService.clear(bound.id);
        viewCache.clear(bound.id);
        planService.haltOnIdentityChange(bound.id);
        void autoApprovalService.haltAllOnIdentityChange(bound.id);
        void runApprovalGrants.revokeAll(bound.id);
        boundContexts.delete(bound.id);
        if (isSelected) {
          identityGeneration++;
          selectedContext = undefined;
          selectedSession = undefined;
        }
      } else {
        monitors.get(bound.id)?.updateToken(currentSession.accessToken);
        if (isSelected) {
          const tokenChanged = currentSession.accessToken !== selectedSession?.accessToken;
          selectedSession = currentSession;
          if (tokenChanged) {
            for (const refresh of panelSessionRefreshers.get(bound.id) ?? []) refresh();
          }
        }
      }
    }
  });
  context.subscriptions.push(
    select,
    open,
    openActionCenter,
    openCompanion,
    openLatestRun,
    openPipeline,
    openRepositoryDeck,
    openWorkflowFile,
    pinWorkflow,
    unpinWorkflow,
    moveRepositoryUp,
    moveRepositoryDown,
    sortWorkspaceTree,
    searchPipelines,
    refreshTree,
    codeLens,
    launcherView,
    workspaceTree,
    repositoriesChanged,
    ...(workflowFilesWatcher ? [workflowFilesWatcher] : []),
    sessionChange,
    statusTicker,
    new vscode.Disposable(() => {
      for (const monitor of monitors.values()) monitor.dispose();
      monitors.clear();
      localPlanScheduler.dispose();
      scheduler.dispose();
    }),
  );
  return {
    getActiveContext: () => selectedContext,
    getScheduler: () => scheduler,
    getPlanStore: () => planStore,
    getPlanService: () => planService,
  };
}

function historyResponse(history: MergedHistory, fromCache: boolean) {
  return {
    runs: history.runs,
    page: history.page,
    totalCount: history.totalCount,
    hasMore: history.hasMore,
    metrics: runMetrics(history.runs),
    partial: history.hasMore,
    capped: history.page === MAX_HISTORY_PAGES && history.page * HISTORY_PAGE_SIZE < history.totalCount,
    ...(fromCache ? { cachedAt: history.cachedAt } : {}),
  };
}

function isRestrictedHistoryError(error: AppError): boolean {
  return ["authentication_required", "auth_or_org_required", "inaccessible", "permission_restricted"].includes(error.code);
}

function sameInputValues(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function readWorkflowGroups(repoState: RepositoryState): Record<string, string> {
  const parsed = workflowGroupsSchema.safeParse(repoState.get("workflowGroups"));
  return parsed.success ? parsed.data : {};
}

