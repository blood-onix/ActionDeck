import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import type { RepositoryContext } from "../../domain/models/repository";
import type { RemoteWorkflow } from "../../domain/models/workflow";
import type { WorkflowRunRecord } from "../../domain/models/run";
import { classifyGitHubError } from "./classify-error";
import { workflowPathFromRunPath } from "../../domain/services/workflow-run-path";

const GitHubOctokit = Octokit.plugin(throttling, retry);
type WorkflowRunResponse = Awaited<
  ReturnType<ReturnType<typeof createGitHubClient>["rest"]["actions"]["listWorkflowRunsForRepo"]>
>["data"]["workflow_runs"][number];

export function createGitHubClient(token: string, onRateLimit?: (retryAfter: number) => void) {
  return new GitHubOctokit({
    auth: token,
    userAgent: "ActionDeck-VSCode",
    throttle: {
      onRateLimit(retryAfter: number, options: { method?: string }, _octokit: unknown, retryCount: number) {
        if (options.method?.toUpperCase() !== "GET" || retryCount > 0) return false;
        onRateLimit?.(retryAfter);
        return false;
      },
      onSecondaryRateLimit(retryAfter: number, options: { method?: string }, _octokit: unknown) {
        if (options.method?.toUpperCase() !== "GET") return false;
        onRateLimit?.(retryAfter);
        return false;
      },
    },
    request: { retries: 0 },
  });
}

export async function loadDashboard(
  client: ReturnType<typeof createGitHubClient>,
  context: RepositoryContext,
  signal?: AbortSignal,
) {
  const [inventory, runPage] = await Promise.all([
    loadWorkflowInventory(client, context, signal),
    loadRepositoryRunPage(client, context, signal),
  ]);
  return {
    workflows: inventory.workflows,
    runs: runPage.runs,
    partial: inventory.partial || runPage.partial,
  };
}

export async function loadWorkflowInventory(
  client: ReturnType<typeof createGitHubClient>,
  context: RepositoryContext,
  signal?: AbortSignal,
) {
  try {
    const response = await client.rest.actions.listRepoWorkflows({
      owner: context.owner, repo: context.repo, per_page: 100,
      request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
    });
    const workflows: RemoteWorkflow[] = response.data.workflows.map((workflow) => ({
      id: workflow.id,
      path: workflow.path.replace(/^\//, ""),
      name: workflow.name,
      state: workflow.state,
      htmlUrl: workflow.html_url,
    }));
    return {
      workflows,
      partial: response.data.total_count > workflows.length,
    };
  } catch (error) {
    throw classifyGitHubError(error);
  }
}

export async function loadRepositoryRunPage(
  client: ReturnType<typeof createGitHubClient>,
  context: RepositoryContext,
  signal?: AbortSignal,
) {
  try {
    const response = await client.rest.actions.listWorkflowRunsForRepo({
      owner: context.owner, repo: context.repo, per_page: 100,
      request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
    });
    const runs: WorkflowRunRecord[] = response.data.workflow_runs.map(mapRun);
    return { runs, partial: response.data.total_count > runs.length };
  } catch (error) {
    throw classifyGitHubError(error);
  }
}

export async function loadWorkflowHistory(
  client: ReturnType<typeof createGitHubClient>,
  context: RepositoryContext,
  workflowId: number,
  page = 1,
  signal?: AbortSignal,
) {
  if (!Number.isInteger(workflowId) || workflowId < 1 || !Number.isInteger(page) || page < 1 || page > 5) {
    throw new Error("Workflow history request is outside the supported bounds.");
  }
  try {
    const response = await client.rest.actions.listWorkflowRuns({
      owner: context.owner,
      repo: context.repo,
      workflow_id: workflowId,
      page,
      per_page: 100,
      request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
    });
    const runs = response.data.workflow_runs.map(mapRun);
    return {
      runs,
      page,
      totalCount: response.data.total_count,
      hasMore: page * 100 < response.data.total_count,
    };
  } catch (error) {
    throw classifyGitHubError(error);
  }
}

export function mapRun(run: WorkflowRunResponse): WorkflowRunRecord {
  return {
    id: run.id,
    workflowId: run.workflow_id,
    ...(run.path ? { workflowPath: workflowPathFromRunPath(run.path) ?? run.path.replace(/@.*$/, "") } : {}),
    ...(run.name ? { workflowName: run.name } : {}),
    attemptCount: run.run_attempt ?? 1,
    hydration: "summary",
    displayTitle: run.display_title,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    event: run.event,
    branch: run.head_branch ?? "",
    headSha: run.head_sha,
    ...(run.actor ? { actor: { id: run.actor.id, login: run.actor.login } } : {}),
    ...(run.triggering_actor
      ? { triggeringActor: { id: run.triggering_actor.id, login: run.triggering_actor.login } }
      : {}),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    ...(run.run_started_at ? { runStartedAt: run.run_started_at } : {}),
    ...(run.status === "completed" ? { completedAt: run.updated_at } : {}),
    htmlUrl: run.html_url,
  };
}
