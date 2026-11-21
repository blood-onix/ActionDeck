import * as vscode from "vscode";
import type { ReleasePlan } from "../../domain/models/release-plan";
import {
  primaryRepository,
  resolveStatusBarState,
  type RepositoryPlanStatus,
} from "../../application/plans/plan-summary";

/**
 * Aggregates plan and approval state across every monitored repository so switching
 * the dashboard repository never hides work that is still running elsewhere.
 */
export class PlanStatusBarTicker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly statuses = new Map<string, RepositoryPlanStatus>();
  private initialized = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = "actiondeck.openActionCenter";
    this.item.tooltip = "ActionDeck Release Plans & Action Center";
  }

  update(plans: readonly ReleasePlan[], pendingApprovalCount = 0, repositoryId?: string): void {
    const key = repositoryId ?? plans[0]?.repositoryId;
    if (key === undefined) return;
    this.initialized = true;
    this.statuses.set(key, { plans, pendingApprovals: pendingApprovalCount });
    this.render();
  }

  /** Updates plan counts while keeping the last known pending-approval count for the repository. */
  updatePlans(repositoryId: string, plans: readonly ReleasePlan[]): void {
    this.update(plans, this.statuses.get(repositoryId)?.pendingApprovals ?? 0, repositoryId);
  }

  remove(repositoryId: string): void {
    if (this.statuses.delete(repositoryId)) this.render();
  }

  primaryRepositoryId(): string | undefined {
    return primaryRepository(this.statuses);
  }

  private render(): void {
    if (!this.initialized && this.statuses.size === 0) {
      this.item.hide();
      return;
    }

    const state = resolveStatusBarState(this.statuses.values());
    this.item.text = state.text;
    this.item.backgroundColor = state.warningBackground
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
