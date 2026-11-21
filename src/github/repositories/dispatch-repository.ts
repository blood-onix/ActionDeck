import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { BranchInventory, DispatchTarget, EnvironmentInventory } from "../../domain/models/dispatch";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import { parseWorkflowDispatchInputs } from "../../application/dispatch/dispatch-validation";
import { parseWorkflowEnvironments } from "../../application/workflows/workflow-environments";
import type { WorkflowRunRecord } from "../../domain/models/run";
import { createGitHubClient, mapRun } from "../client/github-client";
import { classifyGitHubError } from "../client/classify-error";
import { RepositoryScheduler, type SchedulerLease } from "../rate-limit/repository-scheduler";

const maximumWorkflowBytes = 1024 * 1024;
const maximumEnvironmentPages = 5;
const maximumBranchPages = 5;

export class DispatchRepository {
  constructor(
    private readonly scheduler: RepositoryScheduler,
    private readonly context: RepositoryContext,
    private readonly token: string,
    private readonly lease?: SchedulerLease,
  ) {}

  async loadTarget(workflowId: number, ref: string, signal?: AbortSignal): Promise<DispatchTarget> {
    if (!Number.isInteger(workflowId) || workflowId < 1) {
      throw new AppError("invalid_input", "A remote workflow ID is required.");
    }
    if (ref && !isValidRef(ref)) throw new AppError("invalid_input", "A valid remote branch or ref is required.");

    const client = this.client();
    const [repository, workflow] = await Promise.all([
      this.scheduler.schedule(
        this.context.id,
        "dispatch:repository",
        async () => (await client.rest.repos.get({
          owner: this.context.owner,
          repo: this.context.repo,
          request: this.requestOptions(signal),
        })).data,
        this.options(signal),
      ),
      this.scheduler.schedule(
        this.context.id,
        `dispatch:workflow:${workflowId}`,
        async () => (await client.rest.actions.getWorkflow({
          owner: this.context.owner,
          repo: this.context.repo,
          workflow_id: workflowId,
          request: this.requestOptions(signal),
        })).data,
        this.options(signal),
      ),
    ]);

    const defaultBranch = repository.default_branch;
    if (!defaultBranch) {
      return {
        state: "blocked",
        workflowId,
        ref,
        reason: "The repository has no default branch to verify the workflow against.",
      };
    }
    const selectedRef = ref || defaultBranch;
    const workflowPath = normalizeWorkflowPath(workflow.path);
    if (!workflowPath) {
      return {
        state: "blocked",
        workflowId,
        ref: selectedRef,
        defaultBranch,
        reason: "GitHub did not return a supported workflow file path.",
      };
    }
    if (workflow.state !== "active") {
      return {
        state: "blocked",
        workflowId,
        workflowPath,
        ref: selectedRef,
        defaultBranch,
        reason: "This remote workflow is disabled.",
      };
    }
    const defaultSource = await this.readWorkflowAtRef(workflowPath, defaultBranch, signal);
    if (defaultSource.state === "missing_or_inaccessible") {
      return {
        state: "blocked",
        workflowId,
        workflowPath,
        ref,
        defaultBranch,
        reason: "The workflow is missing or inaccessible on the repository default branch.",
      };
    }
    const selectedSource = selectedRef === defaultBranch
      ? defaultSource
      : await this.readWorkflowAtRef(workflowPath, selectedRef, signal);
    if (selectedSource.state === "missing_or_inaccessible") {
      return {
        state: "blocked",
        workflowId,
        workflowPath,
        ref: selectedRef,
        defaultBranch,
        reason: "The workflow is missing or inaccessible on the selected ref.",
      };
    }
    const definition = parseWorkflowDispatchInputs(selectedSource.source, selectedRef);
    const environments = parseWorkflowEnvironments(selectedSource.source);
    if (definition.state !== "available") {
      return {
        state: "blocked",
        workflowId,
        workflowPath,
        ref: selectedRef,
        defaultBranch,
        reason: definition.reason,
      };
    }
    return {
      state: "available",
      workflowId,
      workflowPath,
      ref: selectedRef,
      defaultBranch,
      inputs: definition.inputs,
      ...(environments.length > 0 ? { environments } : {}),
    };
  }

  /** Up to 500 branch names; repositories with more are marked truncated and still accept typed refs. */
  async listBranches(signal?: AbortSignal): Promise<BranchInventory> {
    const names: string[] = [];
    for (let page = 1; page <= maximumBranchPages; page++) {
      const response = await this.scheduler.schedule(
        this.context.id,
        `dispatch:branches:${page}`,
        async () => (await this.client().rest.repos.listBranches({
          owner: this.context.owner,
          repo: this.context.repo,
          page,
          per_page: 100,
          request: this.requestOptions(signal),
        })).data,
        this.options(signal),
      );
      names.push(...response.map((branch) => branch.name));
      if (response.length < 100) return { names, truncated: false };
    }
    return { names, truncated: true };
  }

  async listEnvironments(signal?: AbortSignal): Promise<EnvironmentInventory> {
    const names: string[] = [];
    let totalCount = 0;
    for (let page = 1; page <= maximumEnvironmentPages; page++) {
      try {
        const response = await this.scheduler.schedule(
          this.context.id,
          `dispatch:environments:${page}`,
          async () => (await this.client().rest.repos.getAllEnvironments({
            owner: this.context.owner,
            repo: this.context.repo,
            page,
            per_page: 100,
            request: this.requestOptions(signal),
          })).data,
          this.options(signal),
        );
        const pageEnvironments = response.environments;
        if (!pageEnvironments) {
          return {
            state: "unavailable",
            reason: "GitHub returned an incomplete environment inventory.",
            manualEntryAllowed: false,
          };
        }
        totalCount = response.total_count ?? pageEnvironments.length;
        names.push(...pageEnvironments.map((environment) => environment.name));
        if (names.length >= totalCount || pageEnvironments.length < 100) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        const classified = error instanceof AppError ? error : classifyGitHubError(error);
        if (classified.code === "inaccessible" || classified.code === "permission_restricted") {
          return {
            state: "permission_restricted",
            reason: "GitHub restricted environment listing; enter and validate an environment name manually.",
            manualEntryAllowed: true,
          };
        }
        return {
          state: "unavailable",
          reason: classified.message,
          manualEntryAllowed: false,
        };
      }
    }
    return names.length < totalCount
      ? { state: "partial", names, manualEntryAllowed: true }
      : { state: "loaded", names };
  }

  submit(workflowId: number, ref: string, inputs: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void> {
    return this.scheduler.schedule(
      this.context.id,
      `dispatch:submit:${randomUUID()}`,
      async () => {
        await this.client().rest.actions.createWorkflowDispatch({
          owner: this.context.owner,
          repo: this.context.repo,
          workflow_id: workflowId,
          ref,
          inputs,
          request: { retries: 0, ...(signal ? { signal } : {}) },
        });
      },
      this.options(signal),
    );
  }

  listAssociationCandidates(
    workflowId: number,
    submittedAt: number,
    acceptedAt: number,
    signal?: AbortSignal,
  ): Promise<{ runs: WorkflowRunRecord[]; partial: boolean }> {
    const earliest = new Date(submittedAt - 10_000).toISOString();
    const latest = new Date(acceptedAt + 120_000).toISOString();
    return this.scheduler.schedule(
      this.context.id,
      `dispatch:association:${workflowId}:${earliest}:${latest}`,
      async () => {
        const response = await this.client().rest.actions.listWorkflowRuns({
          owner: this.context.owner,
          repo: this.context.repo,
          workflow_id: workflowId,
          created: `${earliest}..${latest}`,
          per_page: 100,
          request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
        });
        const runs = response.data.workflow_runs.map(mapRun);
        return { runs, partial: response.data.total_count > runs.length };
      },
      this.options(signal),
    );
  }

  private async readWorkflowAtRef(
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ state: "available"; source: string } | { state: "missing_or_inaccessible" }> {
    try {
      const source = await this.scheduler.schedule(
        this.context.id,
        `dispatch:workflow-source:${ref}:${path}`,
        async () => {
          const response = await this.client().request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
              owner: this.context.owner,
              repo: this.context.repo,
              path,
              ref,
              request: this.requestOptions(signal),
            },
          );
          if (!isEncodedWorkflowFile(response.data)) {
            throw new AppError("inaccessible", "Workflow source is unavailable at the requested ref.");
          }
          const encoded = response.data.content.replace(/\s/g, "");
          if (encoded.length > Math.ceil(maximumWorkflowBytes * 4 / 3)) {
            throw new AppError("inaccessible", "Workflow source exceeds the supported size.");
          }
          const bytes = Buffer.from(encoded, "base64");
          if (bytes.byteLength > maximumWorkflowBytes) {
            throw new AppError("inaccessible", "Workflow source exceeds the supported size.");
          }
          return bytes.toString("utf8");
        },
        this.options(signal),
      );
      return { state: "available", source };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof AppError && error.code === "cancelled") throw error;
      if (httpStatus(error) === 404 || (error instanceof AppError && error.code === "inaccessible")) {
        return { state: "missing_or_inaccessible" };
      }
      throw error instanceof AppError ? error : classifyGitHubError(error);
    }
  }

  private client(): ReturnType<typeof createGitHubClient> {
    return createGitHubClient(
      this.token,
      (retryAfter) => this.scheduler.defer(this.context.id, retryAfter * 1000),
    );
  }

  private requestOptions(signal?: AbortSignal) {
    return { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) };
  }

  private options(signal?: AbortSignal) {
    return {
      ...(this.lease ? { lease: this.lease } : {}),
      ...(signal ? { signal } : {}),
    };
  }
}

function isValidRef(ref: string): boolean {
  return ref.trim().length > 0 && ref.length <= 255 && !/[\u0000-\u001f\u007f]/.test(ref);
}

function normalizeWorkflowPath(path: string): string | undefined {
  const normalized = path.replace(/^\/+/, "");
  return /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(normalized) &&
    !normalized.split("/").includes("..")
    ? normalized
    : undefined;
}

function isEncodedWorkflowFile(
  value: unknown,
): value is { type: "file"; encoding: "base64"; content: string } {
  return value !== null
    && typeof value === "object"
    && "type" in value
    && value.type === "file"
    && "encoding" in value
    && value.encoding === "base64"
    && "content" in value
    && typeof value.content === "string";
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}
