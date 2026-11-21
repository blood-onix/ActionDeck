import type { RepositoryContext } from "../../domain/models/repository";
import type {
  EnvironmentSummary,
  RunnerSummary,
  SecretMetadata,
  SettingsRestriction,
  VariableSummary,
} from "../../domain/models/settings";
import {
  mapErrorToCardState,
  type SettingsRepositoryPort,
  type VariablesAndSecrets,
} from "../../application/repositories/settings-service";
import { AppError } from "../../domain/models/errors";
import { classifyGitHubError } from "../client/classify-error";
import { createGitHubClient } from "../client/github-client";
import { RepositoryScheduler, type SchedulerLease } from "../rate-limit/repository-scheduler";

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const MAX_ENVIRONMENTS = 20;
const ENVIRONMENT_CONCURRENCY = 4;

interface RawVariable { name?: string; value?: string }
interface RawSecret { name?: string; updated_at?: string }
interface RawEnvironment {
  id?: number;
  name?: string;
  protection_rules?: Array<{ type?: string; wait_timer?: number; reviewers?: unknown[] }>;
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
}

export class SettingsRepository implements SettingsRepositoryPort {
  constructor(
    private readonly scheduler: RepositoryScheduler,
    private readonly context: RepositoryContext,
    private readonly token: string,
    private readonly lease?: SchedulerLease,
  ) {}

  loadEnvironments(signal?: AbortSignal): Promise<EnvironmentSummary[]> {
    return this.scheduler.schedule(
      this.context.id,
      "settings:environments",
      async () => (await this.listEnvironments(signal)).environments,
      this.options(signal),
    );
  }

  loadVariablesAndSecrets(signal?: AbortSignal): Promise<VariablesAndSecrets> {
    return this.scheduler.schedule(
      this.context.id,
      "settings:variables-and-secrets",
      async () => {
        const variables: VariableSummary[] = [];
        const secrets: SecretMetadata[] = [];
        const restrictions: SettingsRestriction[] = [];
        const failures: unknown[] = [];
        let attempts = 0;
        let truncated = false;

        // Every endpoint degrades on its own so one restricted scope never hides the others.
        const collect = async <T>(
          scope: SettingsRestriction["scope"],
          resource: SettingsRestriction["resource"],
          environmentName: string | undefined,
          load: () => Promise<{ items: T[]; truncated: boolean }>,
          sink: T[],
        ) => {
          attempts += 1;
          try {
            const page = await load();
            sink.push(...page.items);
            truncated ||= page.truncated;
          } catch (error) {
            if (signal?.aborted) throw error;
            const appError = error instanceof AppError ? error : classifyGitHubError(error);
            failures.push(appError);
            restrictions.push({
              scope,
              resource,
              ...(environmentName ? { environmentName } : {}),
              state: mapErrorToCardState(appError),
              reason: appError.message,
            });
          }
        };

        const base = { owner: this.context.owner, repo: this.context.repo };
        await Promise.all([
          collect("repository", "variables", undefined, () => this.listPages(
            "GET /repos/{owner}/{repo}/actions/variables", base, "variables", signal,
            (v: RawVariable): VariableSummary => ({ name: v.name ?? "", value: v.value ?? "", scope: "repository" }),
          ), variables),
          collect("repository", "secrets", undefined, () => this.listPages(
            "GET /repos/{owner}/{repo}/actions/secrets", base, "secrets", signal,
            (s: RawSecret): SecretMetadata => ({ name: s.name ?? "", updatedAt: s.updated_at ?? "", scope: "repository" }),
          ), secrets),
        ]);

        attempts += 1;
        let environments: EnvironmentSummary[] = [];
        try {
          const listed = await this.listEnvironments(signal);
          environments = listed.environments.slice(0, MAX_ENVIRONMENTS);
          truncated ||= listed.truncated || listed.environments.length > MAX_ENVIRONMENTS;
        } catch (error) {
          if (signal?.aborted) throw error;
          const appError = error instanceof AppError ? error : classifyGitHubError(error);
          failures.push(appError);
          restrictions.push({
            scope: "environment",
            resource: "environments",
            state: mapErrorToCardState(appError),
            reason: appError.message,
          });
        }

        for (let i = 0; i < environments.length; i += ENVIRONMENT_CONCURRENCY) {
          await Promise.all(environments.slice(i, i + ENVIRONMENT_CONCURRENCY).flatMap((environment) => {
            const params = { ...base, environment_name: environment.name };
            return [
              collect("environment", "variables", environment.name, () => this.listPages(
                "GET /repos/{owner}/{repo}/environments/{environment_name}/variables", params, "variables", signal,
                (v: RawVariable): VariableSummary => ({
                  name: v.name ?? "",
                  value: v.value ?? "",
                  scope: "environment",
                  environmentName: environment.name,
                }),
              ), variables),
              collect("environment", "secrets", environment.name, () => this.listPages(
                "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets", params, "secrets", signal,
                (s: RawSecret): SecretMetadata => ({
                  name: s.name ?? "",
                  updatedAt: s.updated_at ?? "",
                  scope: "environment",
                  environmentName: environment.name,
                }),
              ), secrets),
            ];
          }));
        }

        // Only surface an error card when nothing at all could be loaded.
        if (attempts > 0 && failures.length === attempts) throw failures[0];
        return {
          variables,
          secrets,
          ...(restrictions.length > 0 ? { restrictions } : {}),
          ...(truncated ? { truncated } : {}),
        };
      },
      this.options(signal),
    );
  }

  loadRunners(signal?: AbortSignal): Promise<RunnerSummary[]> {
    return this.scheduler.schedule(
      this.context.id,
      "settings:runners",
      async () => {
        const client = this.client();
        const response = await client.request("GET /repos/{owner}/{repo}/actions/runners", {
          owner: this.context.owner,
          repo: this.context.repo,
          per_page: 50,
          request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
        });
        const items = (response.data as { runners?: Array<{
          id?: number;
          name?: string;
          os?: string;
          status?: string;
          busy?: boolean;
          labels?: Array<{ name?: string }>;
        }> }).runners ?? [];
        return items.map((r) => ({
          id: r.id ?? 0,
          name: r.name ?? "unknown",
          os: r.os ?? "unknown",
          labels: (r.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
          online: r.status === "online",
          busy: Boolean(r.busy),
        }));
      },
      this.options(signal),
    );
  }

  private async listEnvironments(signal?: AbortSignal): Promise<{ environments: EnvironmentSummary[]; truncated: boolean }> {
    const page = await this.listPages(
      "GET /repos/{owner}/{repo}/environments",
      { owner: this.context.owner, repo: this.context.repo },
      "environments",
      signal,
      (env: RawEnvironment): EnvironmentSummary => {
        const waitRule = env.protection_rules?.find((r) => typeof r.wait_timer === "number");
        const reviewerRule = env.protection_rules?.find((r) => Array.isArray(r.reviewers));
        return {
          id: env.id ?? 0,
          name: env.name ?? "unknown",
          ...(typeof waitRule?.wait_timer === "number" ? { waitTimer: waitRule.wait_timer } : {}),
          reviewerCount: reviewerRule?.reviewers?.length ?? 0,
          branchPolicy: env.deployment_branch_policy?.protected_branches
            ? "protected_branches"
            : env.deployment_branch_policy?.custom_branch_policies
              ? "custom_branch_policies"
              : "all_branches",
        };
      },
    );
    return { environments: page.items, truncated: page.truncated };
  }

  // Bounded pagination: stops after MAX_PAGES and reports truncation instead of walking unbounded lists.
  private async listPages<Raw, Item>(
    route: string,
    params: Record<string, unknown>,
    key: string,
    signal: AbortSignal | undefined,
    map: (raw: Raw) => Item,
  ): Promise<{ items: Item[]; truncated: boolean }> {
    const client = this.client();
    const request = (route_: string, parameters: Record<string, unknown>) =>
      client.request(route_ as never, parameters as never) as Promise<{ data: unknown }>;
    const items: Item[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await request(route, {
        ...params,
        per_page: PAGE_SIZE,
        page,
        request: { retries: 1, retryAfter: 0.01, ...(signal ? { signal } : {}) },
      });
      const data = (response.data ?? {}) as Record<string, unknown>;
      const batch = Array.isArray(data[key]) ? (data[key] as Raw[]) : [];
      items.push(...batch.map(map));
      const total = typeof data.total_count === "number" ? data.total_count : undefined;
      if (batch.length < PAGE_SIZE || (total !== undefined && items.length >= total)) {
        return { items, truncated: false };
      }
    }
    return { items, truncated: true };
  }

  private client() {
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
