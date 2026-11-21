import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient, loadDashboard, loadWorkflowHistory } from "../../src/github/client/github-client";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub client retry policy", () => {
  it("retries bounded reads but never retries mutations", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ full_name: "acme/demo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValue(new Response(JSON.stringify({ message: "temporary" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    const client = createGitHubClient("test-token");

    await expect(client.request("GET /repos/{owner}/{repo}", {
      owner: "acme",
      repo: "demo",
      request: { retries: 1, retryAfter: 0.01 },
    })).resolves.toMatchObject({ data: { full_name: "acme/demo" } });
    expect(fetch).toHaveBeenCalledTimes(2);

    await expect(client.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      owner: "acme",
      repo: "demo",
      workflow_id: 7,
      ref: "main",
    })).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("loads a bounded workflow-specific history page and reports remaining pages", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      total_count: 101,
      workflow_runs: [{
        id: 8,
        workflow_id: 7,
        display_title: "Ship release",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
        head_sha: "abc",
        run_attempt: 3,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:01:00Z",
        run_started_at: "2026-01-01T00:00:10Z",
        html_url: "https://github.com/acme/demo/actions/runs/8",
        actor: { id: 1, login: "author" },
        triggering_actor: { id: 2, login: "trigger" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await loadWorkflowHistory(createGitHubClient("test-token"), {
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, 7);
    expect(result.runs[0]).toMatchObject({
      displayTitle: "Ship release",
      attemptCount: 3,
      hydration: "summary",
      actor: { login: "author" },
      triggeringActor: { login: "trigger" },
    });
    expect(result.hasMore).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("per_page=100");
  });

  it("hydrates a bounded workflow inventory and repository run page without per-workflow fan-out", async () => {
    const requestUrls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestUrls.push(url);
      if (url.includes("/actions/workflows?")) {
        return new Response(JSON.stringify({
          total_count: 100,
          workflows: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            path: `.github/workflows/workflow-${index + 1}.yml`,
            name: `workflow-${index + 1}`,
            state: "active",
            html_url: `https://github.com/acme/demo/actions/workflows/${index + 1}`,
          })),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ total_count: 600, workflow_runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await loadDashboard(createGitHubClient("test-token"), {
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    });
    expect(result.workflows).toHaveLength(100);
    expect(result.partial).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestUrls.every((url) => !/\/actions\/workflows\/\d+\/runs/.test(url))).toBe(true);
  });
});
