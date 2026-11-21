import type { RunApprovalGrant } from "../../domain/models/approval";
import type { RepositoryContext } from "../../domain/models/repository";
import type { WorkflowRunRecord } from "../../domain/models/run";
import { AppError } from "../../domain/models/errors";
import { associateDispatchRun } from "../dispatch/run-association";
import type { RunApprovalGrantStore } from "../../persistence/run-approval-grant-store";

/** A grant applies to one run for at most a day; a run waiting longer needs a human. */
export const RUN_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How long to keep looking for the dispatched run before giving the grant up. */
const UNBOUND_GRANT_WINDOW_MS = 10 * 60 * 1000;
const MAX_GRANTS_PER_REPOSITORY = 20;

export class RunApprovalGrantService {
  constructor(
    private readonly store: RunApprovalGrantStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(repositoryId: string): RunApprovalGrant[] {
    const now = this.now();
    return this.store.list(repositoryId).filter((grant) => grant.expiresAt > now);
  }

  async grant(
    context: RepositoryContext,
    request: {
      readonly workflowId: number;
      readonly ref: string;
      readonly environments: readonly string[] | null;
      readonly submittedAt: number;
      readonly acceptedAt: number;
      readonly runId?: number;
    },
  ): Promise<RunApprovalGrant> {
    if (!context.authenticatedUserId) {
      throw new AppError("authentication_required", "Authenticated user identity is required.");
    }
    const now = this.now();
    const grant: RunApprovalGrant = {
      id: `grant-${request.workflowId}-${request.submittedAt}`,
      repositoryId: context.id,
      authenticatedUserId: context.authenticatedUserId,
      workflowId: request.workflowId,
      ref: request.ref,
      environments: request.environments === null ? null : [...request.environments],
      submittedAt: request.submittedAt,
      acceptedAt: request.acceptedAt,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      createdAt: now,
      expiresAt: now + RUN_GRANT_LIFETIME_MS,
    };
    const kept = this.list(context.id).filter((existing) => existing.id !== grant.id);
    await this.store.replace(context.id, [...kept, grant].slice(-MAX_GRANTS_PER_REPOSITORY));
    return grant;
  }

  /**
   * Binds each unbound grant to the run its dispatch created and drops grants that can no longer apply:
   * expired, finished, never observed, or ambiguous (two candidate runs means we cannot tell which one
   * the user agreed to, so neither is approved).
   */
  async reconcile(context: RepositoryContext, runs: readonly WorkflowRunRecord[]): Promise<void> {
    const stored = this.store.list(context.id);
    if (stored.length === 0) return;
    const now = this.now();
    const next: RunApprovalGrant[] = [];
    for (const grant of stored) {
      if (grant.expiresAt <= now || grant.authenticatedUserId !== context.authenticatedUserId) continue;
      if (grant.runId !== undefined) {
        const run = runs.find((candidate) => candidate.id === grant.runId);
        if (run?.status === "completed") continue;
        next.push(grant);
        continue;
      }
      const association = associateDispatchRun(runs, {
        workflowId: grant.workflowId,
        ref: grant.ref,
        authenticatedUserId: grant.authenticatedUserId,
        submittedAt: grant.submittedAt,
        acceptedAt: grant.acceptedAt,
      });
      if (association.state === "associated_run_found") {
        if (association.run.status !== "completed") next.push({ ...grant, runId: association.run.id });
        continue;
      }
      if (association.state === "ambiguous") continue;
      if (now <= grant.acceptedAt + UNBOUND_GRANT_WINDOW_MS) next.push(grant);
    }
    if (next.length !== stored.length || next.some((grant, index) => grant !== stored[index])) {
      await this.store.replace(context.id, next);
    }
  }

  findForRun(context: RepositoryContext, runId: number): RunApprovalGrant | undefined {
    return this.list(context.id).find((grant) =>
      grant.runId === runId && grant.authenticatedUserId === context.authenticatedUserId);
  }

  async revokeAll(repositoryId: string): Promise<void> {
    await this.store.replace(repositoryId, []);
  }
}
