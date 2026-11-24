import type { RunInspection, JobRecord, LogExcerpt } from "../../domain/models/job";
import { AppError } from "../../domain/models/errors";
import { classifyGitHubError } from "../../github/client/classify-error";
import { boundLogExcerpt, locateStepLog } from "../../domain/services/log-bounds";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { workflowPathFromRunPath } from "../../domain/services/workflow-run-path";

export interface RunResponse {
  id: number;
  run_number: number;
  run_attempt?: number;
  display_title: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  path?: string;
  workflow_id?: number;
  head_branch?: string | null;
  head_sha?: string;
}

export interface JobResponse {
  id: number;
  run_id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  runner_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: Array<{
    number: number;
    name: string;
    status: string | null;
    conclusion: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  }>;
}

export interface InspectionRepository {
  getRun(runId: number, signal?: AbortSignal): Promise<RunResponse>;
  listJobs(
    runId: number,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<{ jobs: JobResponse[]; total_count: number }>;
  getWorkflowSource?(path: string, ref: string, signal?: AbortSignal): Promise<string>;
}

export async function inspectRun(
  repository: InspectionRepository,
  runId: number,
  requestedAttempt?: number,
  signal?: AbortSignal,
): Promise<RunInspection> {
  const run = await repository.getRun(runId, signal);
  const attemptCount = run.run_attempt ?? 1;
  const attempt = requestedAttempt ?? attemptCount;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > attemptCount) {
    throw new AppError("invalid_input", "Requested run attempt is not available.");
  }
  const data = await repository.listJobs(runId, attempt, signal);
  let dependencyResolution: RunInspection["dependencyResolution"] = "unresolved";
  let dependencies: Map<number, string[]> | undefined;
  const workflowPath = workflowPathFromRunPath(run.path);
  const revision = run.head_sha && /^[a-f\d]{40,64}$/i.test(run.head_sha) ? run.head_sha : undefined;
  if (workflowPath && revision && repository.getWorkflowSource) {
    try {
      const source = await repository.getWorkflowSource(workflowPath, revision, signal);
      dependencies = resolveJobDependencies(source, data.jobs);
      dependencyResolution = dependencies ? "resolved" : "unresolved";
    } catch (error) {
      if (signal?.aborted || (error instanceof AppError && error.code === "cancelled")) throw error;
      dependencyResolution = "unavailable";
    }
  }
  const jobs: JobRecord[] = data.jobs.map((job) => {
    const needs = dependencies?.get(job.id);
    return {
      id: job.id,
      runId: job.run_id,
      attempt,
      name: job.name,
      status: job.status ?? "unknown",
      conclusion: job.conclusion,
      ...(job.runner_name ? { runnerName: job.runner_name } : {}),
      ...(job.started_at ? { startedAt: job.started_at } : {}),
      ...(job.completed_at ? { completedAt: job.completed_at } : {}),
      ...(needs ? { needs } : {}),
      steps: (job.steps ?? []).map((step) => ({
        number: step.number,
        name: step.name,
        status: step.status ?? "unknown",
        conclusion: step.conclusion,
        ...(step.started_at ? { startedAt: step.started_at } : {}),
        ...(step.completed_at ? { completedAt: step.completed_at } : {}),
      })),
      logAvailability: "not_loaded",
    };
  });
  return {
    runId: run.id,
    attempt,
    attemptCount,
    hydration: "jobs_loaded",
    ...(run.workflow_id ? { workflowId: run.workflow_id } : {}),
    ...(workflowPath ? { workflowPath } : {}),
    ...(run.head_branch ? { ref: run.head_branch } : {}),
    dependencyResolution,
    title: run.display_title,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    jobs,
  };
}

export interface JobLogRepository {
  loadLog(runId: number, attempt: number, jobId: number, signal?: AbortSignal): Promise<string>;
}

type UnavailableLogAvailability = Extract<LogExcerpt["availability"], "expired" | "restricted" | "unavailable">;

export async function loadJobLogProjection(
  repository: JobLogRepository,
  job: JobRecord,
  stepNumber?: number,
  signal?: AbortSignal,
): Promise<LogExcerpt> {
  const step = stepNumber === undefined ? undefined : job.steps.find((candidate) => candidate.number === stepNumber);
  if (stepNumber !== undefined && !step) {
    throw new AppError("invalid_input", "The selected step does not belong to this job.");
  }
  let raw: string;
  try {
    raw = await repository.loadLog(job.runId, job.attempt, job.id, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const unavailable = classifyLogFailure(error instanceof AppError ? error : classifyGitHubError(error), job);
    if (!unavailable) throw error;
    return {
      jobId: job.id,
      attempt: job.attempt,
      text: "",
      truncated: false,
      retrievedAt: new Date().toISOString(),
      availability: unavailable.availability,
      message: unavailable.message,
      ...(stepNumber === undefined ? {} : { stepNumber }),
    };
  }

  const inProgress = job.status !== "completed";
  const notes: string[] = [];
  if (inProgress) {
    notes.push("The job is still running; GitHub exposes logs as a point-in-time snapshot, not a live stream, and this one may be incomplete.");
  }
  if (!step) {
    return withMessage(boundLogExcerpt(job.id, job.attempt, raw), notes);
  }
  if (step.conclusion === "skipped") {
    return {
      ...boundLogExcerpt(job.id, job.attempt, "", undefined, step.number),
      stepBoundary: "identified",
      message: "This step was skipped, so it wrote no log.",
    };
  }
  const located = locateStepLog(raw, job.steps, step.number);
  if (located.state === "identified") {
    return {
      ...withMessage(boundLogExcerpt(job.id, job.attempt, located.text, undefined, step.number), notes),
      stepBoundary: "identified",
    };
  }
  notes.unshift(`${located.reason} Showing the full job log instead of a step section.`);
  return {
    ...withMessage(boundLogExcerpt(job.id, job.attempt, raw, undefined, step.number), notes),
    stepBoundary: "unidentified",
  };
}

function withMessage(excerpt: LogExcerpt, notes: readonly string[]): LogExcerpt {
  return notes.length > 0 ? { ...excerpt, message: notes.join(" ") } : excerpt;
}

function classifyLogFailure(
  error: AppError,
  job: JobRecord,
): { availability: UnavailableLogAvailability; message: string } | undefined {
  switch (error.code) {
    case "stale":
      return { availability: "expired", message: "GitHub has expired this job log; it is no longer retained." };
    case "permission_restricted":
    case "authentication_required":
    case "auth_or_org_required":
      return {
        availability: "restricted",
        message: "Your GitHub session is not permitted to read this job log. Check repository access and SSO authorization.",
      };
    case "inaccessible":
    case "not_found":
      return {
        availability: "unavailable",
        message: job.status === "completed"
          ? "GitHub did not provide a log for this job."
          : "This job has not finished; GitHub exposes its log only as a completed snapshot and none is available yet.",
      };
    default:
      return undefined;
  }
}

function resolveJobDependencies(
  source: string,
  jobs: readonly JobResponse[],
): Map<number, string[]> | undefined {
  const document = parseDocument(source, { version: "1.2", uniqueKeys: false });
  if (document.errors.length > 0 || !isMap(document.contents)) return undefined;
  const workflowJobs = document.contents.items.find(
    (item) => isScalar(item.key) && item.key.value === "jobs",
  )?.value;
  if (!isMap(workflowJobs) || jobs.length === 0) return undefined;

  const definitions = workflowJobs.items.flatMap((item) => {
    if (!isScalar(item.key) || typeof item.key.value !== "string") return [];
    const definition = isMap(item.value) ? item.value : undefined;
    const declaredName = definition?.items.find(
      (field) => isScalar(field.key) && field.key.value === "name",
    )?.value;
    return [{
      id: item.key.value,
      displayName: isScalar(declaredName) && typeof declaredName.value === "string"
        ? declaredName.value
        : undefined,
      definition,
    }];
  });
  const matched = new Map<string, JobResponse>();
  const jobDefinitions = new Map<number, (typeof definitions)[number]>();
  for (const job of jobs) {
    const candidates = definitions.filter(
      (definition) => definition.id === job.name || definition.displayName === job.name,
    );
    if (candidates.length !== 1) return undefined;
    matched.set(candidates[0]!.id, job);
    jobDefinitions.set(job.id, candidates[0]!);
  }

  const resolved = new Map<number, string[]>();
  for (const job of jobs) {
    const definition = jobDefinitions.get(job.id);
    const needsNode = definition?.definition?.items.find(
      (field) => isScalar(field.key) && field.key.value === "needs",
    )?.value;
    let neededIds: string[] = [];
    if (needsNode !== undefined) {
      if (isScalar(needsNode) && typeof needsNode.value === "string") {
        neededIds = [needsNode.value];
      } else if (isSeq(needsNode)) {
        for (const item of needsNode.items) {
          if (!isScalar(item) || typeof item.value !== "string") return undefined;
          neededIds.push(item.value);
        }
      } else {
        return undefined;
      }
    }
    const neededNames: string[] = [];
    for (const neededId of neededIds) {
      const neededJob = matched.get(neededId);
      if (!neededJob) return undefined;
      neededNames.push(neededJob.name);
    }
    resolved.set(job.id, neededNames);
  }
  return resolved;
}
