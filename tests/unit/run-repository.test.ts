import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRepository } from "../../src/github/repositories/run-repository";
import { RepositoryScheduler } from "../../src/github/rate-limit/repository-scheduler";

afterEach(() => vi.unstubAllGlobals());

describe("run repository", () => {
  it("uses the shared scheduler for bounded repository and workflow history pages", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      total_count: 101,
      workflow_runs: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetch);
    const scheduler = new RepositoryScheduler(2);
    const repository = new RunRepository(scheduler, {
      id: "acme/demo|origin|file:///repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, "test-token");

    try {
      await expect(repository.loadRecent()).resolves.toEqual({ runs: [], partial: true });
      await expect(repository.loadHistory(7, 5)).resolves.toMatchObject({
        runs: [],
        page: 5,
        totalCount: 101,
        hasMore: false,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[0]?.[0])).toContain("/actions/runs?");
      expect(String(fetch.mock.calls[1]?.[0])).toContain("/actions/workflows/7/runs");
      expect(String(fetch.mock.calls[1]?.[0])).toContain("page=5");
    } finally {
      scheduler.dispose();
    }
  });
});
