import type { ReleasePlan } from "../../domain/models/release-plan";

export interface RepositoryPlanStatus {
  readonly plans: readonly ReleasePlan[];
  readonly pendingApprovals: number;
}

export interface PlanStatusSummary {
  readonly active: number;
  readonly scheduled: number;
  readonly blocked: number;
  readonly pendingApprovals: number;
}

const ACTIVE_STATES: ReadonlySet<ReleasePlan["state"]> = new Set(["running", "waiting_approval"]);
const BLOCKED_STATES: ReadonlySet<ReleasePlan["state"]> = new Set(["blocked_uncertain", "missed_schedule"]);

export function summarizePlanStatus(statuses: Iterable<RepositoryPlanStatus>): PlanStatusSummary {
  let active = 0;
  let scheduled = 0;
  let blocked = 0;
  let pendingApprovals = 0;
  for (const status of statuses) {
    pendingApprovals += status.pendingApprovals;
    for (const plan of status.plans) {
      if (ACTIVE_STATES.has(plan.state)) active++;
      else if (plan.state === "scheduled") scheduled++;
      else if (BLOCKED_STATES.has(plan.state)) blocked++;
    }
  }
  return { active, scheduled, blocked, pendingApprovals };
}

/** Repository that most needs attention: pending approvals first, then blocked, active, scheduled. */
export function primaryRepository(statuses: ReadonlyMap<string, RepositoryPlanStatus>): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const [id, status] of statuses) {
    const summary = summarizePlanStatus([status]);
    const score = summary.pendingApprovals * 1_000 + summary.blocked * 100 + summary.active * 10 + summary.scheduled;
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  }
  return best?.id;
}

export type StatusBarState =
  | {
      readonly kind: "blocked";
      readonly planId: string;
      readonly planName: string;
      readonly reasonShort: string;
      readonly text: string;
      readonly warningBackground: true;
    }
  | {
      readonly kind: "countdown";
      readonly planId: string;
      readonly planName: string;
      readonly remainingMs: number;
      readonly text: string;
      readonly warningBackground: false;
    }
  | {
      readonly kind: "plan";
      readonly planId: string;
      readonly planName: string;
      readonly currentStep: number;
      readonly totalSteps: number;
      readonly stageLabel: string;
      readonly text: string;
      readonly warningBackground: false;
    }
  | {
      readonly kind: "idle";
      readonly pendingApprovals: number;
      readonly text: string;
      readonly warningBackground: false;
    };

function formatCountdownMmSs(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function resolveStatusBarState(
  statuses: Iterable<RepositoryPlanStatus>,
  now = Date.now(),
): StatusBarState {
  let pendingApprovals = 0;
  let blockedPlan: ReleasePlan | undefined;
  let countdownPlan: ReleasePlan | undefined;
  let activePlan: ReleasePlan | undefined;

  for (const status of statuses) {
    pendingApprovals += status.pendingApprovals;
    for (const plan of status.plans) {
      if (BLOCKED_STATES.has(plan.state) && !blockedPlan) {
        blockedPlan = plan;
      } else if (plan.state === "scheduled" && !countdownPlan) {
        countdownPlan = plan;
      } else if (ACTIVE_STATES.has(plan.state) && !activePlan) {
        activePlan = plan;
      }
    }
  }

  if (blockedPlan) {
    const reasonShort =
      blockedPlan.blockedReason?.trim() ||
      (blockedPlan.state === "missed_schedule" ? "missed schedule" : "uncertain");
    return {
      kind: "blocked",
      planId: blockedPlan.id,
      planName: blockedPlan.name,
      reasonShort,
      text: `$(warning) Release blocked: ${reasonShort}`,
      warningBackground: true,
    };
  }

  if (countdownPlan) {
    const remainingMs = Math.max(0, (countdownPlan.schedule?.runAtMs ?? now) - now);
    return {
      kind: "countdown",
      planId: countdownPlan.id,
      planName: countdownPlan.name,
      remainingMs,
      text: `$(watch) Release in ${formatCountdownMmSs(remainingMs)}`,
      warningBackground: false,
    };
  }

  if (activePlan) {
    const totalSteps = Math.max(1, activePlan.steps.length);
    const currentStep = Math.min(totalSteps, Math.max(1, activePlan.currentStepIndex + 1));
    const step = activePlan.steps[currentStep - 1];
    const stageLabel =
      step?.workflowPath.split("/").pop()?.replace(/\.ya?ml$/i, "") ??
      (activePlan.state === "waiting_approval" ? "Waiting for Approval" : "Running");
    return {
      kind: "plan",
      planId: activePlan.id,
      planName: activePlan.name,
      currentStep,
      totalSteps,
      stageLabel,
      text: `$(sync~spin) ${activePlan.name} ${currentStep}/${totalSteps} · ${stageLabel}`,
      warningBackground: false,
    };
  }

  return {
    kind: "idle",
    pendingApprovals,
    text: `$(layers) ${pendingApprovals}`,
    warningBackground: false,
  };
}
