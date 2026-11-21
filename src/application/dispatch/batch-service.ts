import { randomUUID } from "node:crypto";
import type { RepositoryContext } from "../../domain/models/repository";
import type { BatchExecutionResult, BatchItemResult } from "../../domain/models/batch";
import { AppError } from "../../domain/models/errors";
import { UiAuthorization } from "./authorization";
import { executeDispatch, type DispatchSubmissionRepository } from "./dispatch-service";

export interface BatchSubmissionItem {
  readonly workflowId: number;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, string>>;
}

export async function executeBatchDispatch(
  repository: DispatchSubmissionRepository,
  context: RepositoryContext,
  authorization: UiAuthorization,
  items: readonly BatchSubmissionItem[],
  options: {
    concurrency?: number;
    onProgress?: (item: BatchItemResult) => void;
    signal?: AbortSignal;
  } = {},
): Promise<BatchExecutionResult> {
  if (items.length === 0) {
    throw new AppError("invalid_input", "Select at least one workflow to dispatch.");
  }

  const targetKey = `batch:${items.map((item) => item.workflowId).join(",")}`;
  if (!authorization.consume({
    repositoryId: context.id,
    target: targetKey,
    ref: items[0]?.ref ?? "",
    inputs: { count: String(items.length) },
  })) {
    throw new AppError("permission_restricted", "Batch authorization does not match the reviewed workflows.");
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 4));
  const results: BatchItemResult[] = items.map((item) => ({
    workflowId: item.workflowId,
    ref: item.ref,
    state: "not_submitted",
  }));

  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      if (options.signal?.aborted) return;
      const index = cursor++;
      const item = items[index];
      if (!item) return;

      const submitting: BatchItemResult = {
        workflowId: item.workflowId,
        ref: item.ref,
        state: "submitting",
      };
      results[index] = submitting;
      options.onProgress?.(submitting);

      const itemAuth = new UiAuthorization();
      itemAuth.authorize({
        repositoryId: context.id,
        target: `workflow:${item.workflowId}`,
        ref: item.ref,
        inputs: item.inputs,
      });

      try {
        const outcome = await executeDispatch(
          repository,
          context,
          itemAuth,
          item,
          undefined,
          options.signal,
        );
        const mapped: BatchItemResult = outcome.state === "associated_run_found"
          ? {
            workflowId: item.workflowId,
            ref: item.ref,
            state: "associated_run_found",
            runId: outcome.runId,
            htmlUrl: outcome.htmlUrl,
          }
          : outcome.state === "completed"
            ? {
              workflowId: item.workflowId,
              ref: item.ref,
              state: "completed",
              runId: outcome.runId,
              conclusion: outcome.conclusion,
              htmlUrl: outcome.htmlUrl,
            }
            : outcome.state === "outcome_uncertain"
              ? {
                workflowId: item.workflowId,
                ref: item.ref,
                state: "outcome_uncertain",
                error: outcome.reconciliation,
              }
              : {
                workflowId: item.workflowId,
                ref: item.ref,
                state: "request_accepted",
                submittedAt: outcome.submittedAt,
                acceptedAt: outcome.acceptedAt,
              };
        results[index] = mapped;
        options.onProgress?.(mapped);
      } catch (error) {
        const isUncertain = error instanceof AppError && (error.code === "network" || error.code === "service");
        const failed: BatchItemResult = {
          workflowId: item.workflowId,
          ref: item.ref,
          state: isUncertain ? "outcome_uncertain" : "failed_to_submit",
          error: error instanceof Error ? error.message : String(error),
        };
        results[index] = failed;
        options.onProgress?.(failed);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return {
    batchId: randomUUID(),
    repositoryId: context.id,
    items: results,
  };
}
