import { Buffer } from "node:buffer";
import type { RepositoryContext } from "../../domain/models/repository";
import { AppError } from "../../domain/models/errors";
import type { JobResponse, RunResponse } from "../../application/runs/inspection-service";
import { LOG_TRUNCATION_MARKER } from "../../domain/services/log-bounds";
import { createGitHubClient } from "../client/github-client";
import { RepositoryScheduler, type SchedulerLease } from "../rate-limit/repository-scheduler";

interface JobRepositoryClient {
  rest: {
    actions: {
      getWorkflowRun(parameters: {
        owner: string; repo: string; run_id: number;
        request?: { retries?: number; retryAfter?: number; signal?: AbortSignal };
      }): Promise<{ data: RunResponse }>;
      listJobsForWorkflowRunAttempt(parameters: {
        owner: string; repo: string; run_id: number; attempt_number: number; per_page: number;
        request?: { retries?: number; retryAfter?: number; signal?: AbortSignal };
      }): Promise<{ data: { jobs: JobResponse[]; total_count: number } }>;
    };
  };
  request(
    route: string,
    parameters: Record<string, unknown> & {
      request?: { redirect?: "manual"; retries?: number; retryAfter?: number; signal?: AbortSignal };
    },
  ): Promise<{ status: number; headers: { location?: string }; data: unknown }>;
}

export class JobRepository {
  constructor(
    private readonly scheduler: RepositoryScheduler,
    private readonly context: RepositoryContext,
    private readonly token: string,
    private readonly lease?: SchedulerLease,
  ) {}

  getRun(runId: number, signal?: AbortSignal): Promise<RunResponse> {
    return this.scheduler.schedule(
      this.context.id,
      `run-metadata:${runId}`,
      async () => (await this.client().rest.actions.getWorkflowRun({
        owner: this.context.owner,
        repo: this.context.repo,
        run_id: runId,
        request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
      })).data,
      this.options(signal),
    );
  }

  listJobs(runId: number, attempt: number, signal?: AbortSignal): Promise<{ jobs: JobResponse[]; total_count: number }> {
    return this.scheduler.schedule(
      this.context.id,
      `run-jobs:${runId}:attempt:${attempt}`,
      async () => (await this.client().rest.actions.listJobsForWorkflowRunAttempt({
        owner: this.context.owner,
        repo: this.context.repo,
        run_id: runId,
        attempt_number: attempt,
        per_page: 100,
        request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
      })).data,
      this.options(signal),
    );
  }

  getWorkflowSource(path: string, ref: string, signal?: AbortSignal): Promise<string> {
    return this.scheduler.schedule(
      this.context.id,
      `run-workflow-source:${ref}:${path}`,
      async () => {
        const response = await this.client().request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner: this.context.owner,
            repo: this.context.repo,
            path,
            ref,
            request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
          },
        );
        if (!isEncodedWorkflowFile(response.data)) {
          throw new AppError("inaccessible", "Workflow source at the run revision is unavailable.");
        }
        const encoded = response.data.content.replace(/\s/g, "");
        if (encoded.length > 1_400_000) {
          throw new AppError("inaccessible", "Workflow source at the run revision exceeds the supported size.");
        }
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.byteLength > 1024 * 1024) {
          throw new AppError("inaccessible", "Workflow source at the run revision exceeds the supported size.");
        }
        return bytes.toString("utf8");
      },
      this.options(signal),
    );
  }

  loadLog(runId: number, attempt: number, jobId: number, signal?: AbortSignal): Promise<string> {
    return this.scheduler.schedule(
      this.context.id,
      `job-log:${runId}:${attempt}:${jobId}`,
      () => loadJobLog(this.client(), this.context, jobId, signal),
      this.options(signal),
    );
  }

  private client(): ReturnType<typeof createGitHubClient> {
    return createGitHubClient(
      this.token,
      (retryAfter) => this.scheduler.defer(this.context.id, retryAfter * 1000),
    );
  }

  private options(signal?: AbortSignal) {
    return {
      ...(this.lease ? { lease: this.lease } : {}),
      ...(signal ? { signal } : {}),
    };
  }
}

function isEncodedWorkflowFile(
  value: unknown,
): value is { type: "file"; encoding: "base64"; content: string } {
  if (!value || typeof value !== "object") return false;
  return "type" in value
    && value.type === "file"
    && "encoding" in value
    && value.encoding === "base64"
    && "content" in value
    && typeof value.content === "string";
}

export async function loadJobLog(
  client: JobRepositoryClient,
  repository: Pick<RepositoryContext, "owner" | "repo">,
  jobId: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isInteger(jobId) || jobId < 1) {
    throw new AppError("invalid_input", "Requested job ID is invalid.");
  }
  const response = await client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
    owner: repository.owner,
    repo: repository.repo,
    job_id: jobId,
    request: {
      redirect: "manual",
      retries: 1,
      retryAfter: 0.01,
      ...(signal ? { signal } : {}),
    },
  });
  if (response.status !== 302 || !response.headers.location) {
    if (typeof response.data === "string") return response.data;
    throw new AppError("inaccessible", "GitHub did not provide an available job log download.");
  }
  const downloadUrl = new URL(response.headers.location);
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.username ||
    downloadUrl.password ||
    downloadUrl.port ||
    !downloadUrl.hostname.endsWith(".blob.core.windows.net")
  ) {
    throw new AppError("inaccessible", "GitHub returned an unsupported job log download host.");
  }
  const downloadSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const download = await fetch(downloadUrl, { redirect: "error", signal: downloadSignal });
  if (!download.ok || !download.body) {
    throw new AppError("inaccessible", "The temporary GitHub job log download is unavailable.");
  }
  const reader = download.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = 2 * 1024 * 1024 - totalBytes;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, Math.max(remaining, 0)));
        totalBytes += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder().decode(bytes);
  return truncated ? `${LOG_TRUNCATION_MARKER}\n${decoded}` : decoded;
}
