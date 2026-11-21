import type { WorkflowRunRecord } from "../../domain/models/run";

export interface DispatchAssociationRequest {
  readonly workflowId: number;
  readonly ref: string;
  readonly authenticatedUserId: string;
  readonly submittedAt: number;
  readonly acceptedAt: number;
}

export type DispatchAssociation =
  | { readonly state: "associated_run_found"; readonly run: WorkflowRunRecord }
  | { readonly state: "not_observed" }
  | { readonly state: "ambiguous"; readonly candidateRunIds: readonly number[] };

const secondsBeforeSubmission = 10;
const secondsAfterAcceptance = 120;

export function associateDispatchRun(
  runs: readonly WorkflowRunRecord[],
  request: DispatchAssociationRequest,
): DispatchAssociation {
  if (
    !Number.isInteger(request.workflowId) ||
    request.workflowId < 1 ||
    !request.authenticatedUserId ||
    !Number.isFinite(request.submittedAt) ||
    !Number.isFinite(request.acceptedAt) ||
    request.acceptedAt < request.submittedAt
  ) {
    return { state: "not_observed" };
  }
  const earliest = request.submittedAt - secondsBeforeSubmission * 1000;
  const latest = request.acceptedAt + secondsAfterAcceptance * 1000;
  const expectedRef = normalizeRef(request.ref);
  if (!expectedRef) return { state: "not_observed" };

  const candidates = runs.filter((run) => {
    const createdAt = Date.parse(run.createdAt);
    return run.workflowId === request.workflowId &&
      normalizeRef(run.branch) === expectedRef &&
      run.event === "workflow_dispatch" &&
      String(run.actor?.id ?? "") === request.authenticatedUserId &&
      Number.isFinite(createdAt) &&
      createdAt >= earliest &&
      createdAt <= latest;
  });
  if (candidates.length === 1) return { state: "associated_run_found", run: candidates[0]! };
  if (candidates.length > 1) {
    return { state: "ambiguous", candidateRunIds: candidates.map((run) => run.id) };
  }
  return { state: "not_observed" };
}

function normalizeRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}
