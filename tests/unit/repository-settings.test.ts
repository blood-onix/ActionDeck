import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsRepository } from "../../src/github/repositories/settings-repository";
import { RepositoryScheduler } from "../../src/github/rate-limit/repository-scheduler";
import { loadSettingsCard } from "../../src/application/repositories/settings-service";
import type { SettingsRepositoryPort } from "../../src/application/repositories/settings-service";
import { AppError } from "../../src/domain/models/errors";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/github/client/github-client", () => ({
  createGitHubClient: () => ({ request: requestMock }),
}));

const context = {
  id: "r1", owner: "o", repo: "r", remoteName: "origin", workspaceFolderUri: "file:///w",
};

function forbidden(): Error & { status: number } {
  return Object.assign(new Error("Forbidden"), { status: 403 });
}

describe("SettingsRepository environment-level entries", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("merges repository and environment variables/secrets and degrades restricted scopes independently", async () => {
    requestMock.mockImplementation(async (route: string, params: Record<string, unknown>) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/environments":
          return { data: { total_count: 2, environments: [
            { id: 1, name: "prod", protection_rules: [{ type: "wait_timer", wait_timer: 30 }] },
            { id: 2, name: "staging" },
          ] } };
        case "GET /repos/{owner}/{repo}/actions/variables":
          return { data: { total_count: 1, variables: [{ name: "REGION", value: "eu" }] } };
        case "GET /repos/{owner}/{repo}/actions/secrets":
          throw forbidden();
        case "GET /repos/{owner}/{repo}/environments/{environment_name}/variables":
          return { data: { total_count: 1, variables: [{ name: `${String(params.environment_name)}_VAR`, value: "x" }] } };
        case "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets":
          if (params.environment_name === "staging") throw forbidden();
          return { data: { total_count: 1, secrets: [{ name: "PROD_KEY", updated_at: "2026-01-01T00:00:00Z", value: "leak" }] } };
        default:
          throw new Error(`unexpected ${route}`);
      }
    });
    const repo = new SettingsRepository(new RepositoryScheduler(), context, "token");

    const result = await repo.loadVariablesAndSecrets();

    expect(result.variables.map((v) => `${v.scope}:${v.environmentName ?? ""}:${v.name}`).sort()).toEqual([
      "environment:prod:prod_VAR",
      "environment:staging:staging_VAR",
      "repository::REGION",
    ]);
    expect(result.secrets).toEqual([
      { name: "PROD_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "environment", environmentName: "prod" },
    ]);
    expect(JSON.stringify(result)).not.toContain("leak");
    expect(result.restrictions).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "repository", resource: "secrets", state: "permission_restricted" }),
      expect.objectContaining({ scope: "environment", resource: "secrets", environmentName: "staging", state: "permission_restricted" }),
    ]));
    expect(result.restrictions).toHaveLength(2);
  });

  it("throws only when every scope fails and bounds pagination", async () => {
    requestMock.mockRejectedValue(forbidden());
    const denied = new SettingsRepository(new RepositoryScheduler(), context, "token");
    await expect(denied.loadVariablesAndSecrets()).rejects.toMatchObject({ code: "permission_restricted" });

    requestMock.mockReset();
    requestMock.mockImplementation(async (route: string) => {
      if (route.endsWith("/environments")) return { data: { total_count: 0, environments: [] } };
      if (route.endsWith("/secrets")) return { data: { total_count: 0, secrets: [] } };
      return { data: { total_count: 1000, variables: Array.from({ length: 100 }, (_, i) => ({ name: `V${i}`, value: "" })) } };
    });
    const big = new SettingsRepository(new RepositoryScheduler(), context, "token");
    const result = await big.loadVariablesAndSecrets();
    const variableCalls = requestMock.mock.calls.filter(([route]) => String(route).endsWith("/actions/variables"));
    expect(variableCalls).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("reports environment wait timers", async () => {
    requestMock.mockResolvedValue({ data: { total_count: 1, environments: [
      { id: 9, name: "prod", protection_rules: [{ type: "wait_timer", wait_timer: 15 }, { type: "required_reviewers", reviewers: [{}, {}] }] },
    ] } });
    const repo = new SettingsRepository(new RepositoryScheduler(), context, "token");
    expect(await repo.loadEnvironments()).toEqual([
      { id: 9, name: "prod", waitTimer: 15, reviewerCount: 2, branchPolicy: "all_branches" },
    ]);
  });
});

describe("Repository Actions settings card service", () => {
  it("isolates card failures and distinguishes loaded, empty, permission_restricted, auth_or_org_required, rate_limited, and temporarily_unavailable", async () => {
    const port: SettingsRepositoryPort = {
      loadEnvironments: vi.fn().mockResolvedValue([]),
      loadVariablesAndSecrets: vi.fn().mockRejectedValue(new AppError("permission_restricted", "Admin required")),
      loadRunners: vi.fn().mockResolvedValue([
        { id: 1, name: "runner-1", os: "Linux", labels: ["self-hosted", "linux"], online: true, busy: false },
      ]),
    };

    const envCard = await loadSettingsCard(port, "environments");
    expect(envCard.state).toBe("empty");

    const varsCard = await loadSettingsCard(port, "variables_and_secrets");
    expect(varsCard.state).toBe("permission_restricted");
    expect(varsCard.reason).toContain("Admin required");

    const runnersCard = await loadSettingsCard(port, "runners");
    expect(runnersCard.state).toBe("loaded");
    if (runnersCard.state === "loaded" && runnersCard.card === "runners") {
      expect(runnersCard.runners[0]?.name).toBe("runner-1");
      expect(runnersCard.pollingNote).toMatch(/polling/i);
    }

    const ssoPort: SettingsRepositoryPort = {
      ...port,
      loadRunners: vi.fn().mockRejectedValue(new AppError("authentication_required", "SSO required")),
    };
    expect((await loadSettingsCard(ssoPort, "runners")).state).toBe("auth_or_org_required");

    const ratePort: SettingsRepositoryPort = {
      ...port,
      loadRunners: vi.fn().mockRejectedValue(new AppError("rate_limited", "Rate limit")),
    };
    expect((await loadSettingsCard(ratePort, "runners")).state).toBe("rate_limited");

    const netPort: SettingsRepositoryPort = {
      ...port,
      loadRunners: vi.fn().mockRejectedValue(new AppError("network", "Offline")),
    };
    expect((await loadSettingsCard(netPort, "runners")).state).toBe("temporarily_unavailable");
  });
});

describe("variables and secrets card with partial restrictions", () => {
  it("stays loaded and carries restrictions", async () => {
    const port: SettingsRepositoryPort = {
      loadEnvironments: vi.fn(),
      loadRunners: vi.fn(),
      loadVariablesAndSecrets: vi.fn().mockResolvedValue({
        variables: [],
        secrets: [],
        restrictions: [{ scope: "environment", resource: "secrets", environmentName: "prod", state: "permission_restricted" }],
      }),
    };
    const card = await loadSettingsCard(port, "variables_and_secrets");
    expect(card.state).toBe("loaded");
    if (card.state === "loaded" && card.card === "variables_and_secrets") {
      expect(card.restrictions).toHaveLength(1);
    }
  });
});
