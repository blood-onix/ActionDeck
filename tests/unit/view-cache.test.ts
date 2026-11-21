import { describe, expect, it } from "vitest";
import { BRANCH_CACHE_TTL_MS, RepositoryViewCache } from "../../src/application/runs/view-cache";
import type { LogExcerpt, RunInspection } from "../../src/domain/models/job";
import { makeRun } from "../fixtures/fakes";

function inspection(overrides: Partial<RunInspection> = {}): RunInspection {
  return {
    runId: 7,
    attempt: 1,
    attemptCount: 1,
    hydration: "jobs_loaded",
    dependencyResolution: "resolved",
    title: "build",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/acme/demo/actions/runs/7",
    jobs: [],
    ...overrides,
  };
}

function log(overrides: Partial<LogExcerpt> = {}): LogExcerpt {
  return { jobId: 3, attempt: 1, text: "ok", truncated: false, retrievedAt: "2026-01-01T00:00:00Z", availability: "loaded", ...overrides };
}

describe("repository view cache", () => {
  it("serves cached branches to the same identity until the TTL passes or the repository is cleared", () => {
    let now = 1_000;
    const cache = new RepositoryViewCache(() => now);
    cache.setBranches("repo", "user-1", { names: ["main", "dev"], truncated: false });
    expect(cache.getBranches("repo", "user-1")?.value.names).toEqual(["main", "dev"]);
    expect(cache.getBranches("repo", "user-2")).toBeUndefined();
    now += BRANCH_CACHE_TTL_MS;
    expect(cache.getBranches("repo", "user-1")).toBeUndefined();
    cache.setBranches("repo", "user-1", { names: ["main"], truncated: false });
    cache.invalidateViews("repo");
    expect(cache.getBranches("repo", "user-1")?.value.names).toEqual(["main"]);
    cache.clear("repo");
    expect(cache.getBranches("repo", "user-1")).toBeUndefined();
  });

  it("serves the dashboard snapshot only to the identity that loaded it", () => {
    const cache = new RepositoryViewCache(() => 1_000);
    cache.setDashboard("repo", "user-1", { workflows: [] });
    expect(cache.getDashboard("repo", "user-1")).toEqual({ value: { workflows: [] }, cachedAt: 1_000, userId: "user-1" });
    expect(cache.getDashboard("repo", "user-2")).toBeUndefined();
    expect(cache.getDashboard("other", "user-1")).toBeUndefined();
  });

  it("keeps older history pages when the newest page is refreshed and drops duplicate runs", () => {
    const cache = new RepositoryViewCache();
    expect(cache.canLoadHistoryPage("repo", 1, 2)).toBe(false);
    cache.putHistoryPage("repo", 1, 1, { runs: [makeRun({ id: 30 }), makeRun({ id: 29 })], totalCount: 250 });
    expect(cache.canLoadHistoryPage("repo", 1, 2)).toBe(true);
    cache.putHistoryPage("repo", 1, 2, { runs: [makeRun({ id: 28 }), makeRun({ id: 27 })], totalCount: 250 });
    // Two new runs arrived: page 1 shifts and overlaps what page 2 already holds.
    const merged = cache.putHistoryPage("repo", 1, 1, {
      runs: [makeRun({ id: 32 }), makeRun({ id: 31 }), makeRun({ id: 30 }), makeRun({ id: 29 }), makeRun({ id: 28 })],
      totalCount: 252,
    });
    expect(merged.runs.map((run) => run.id)).toEqual([32, 31, 30, 29, 28, 27]);
    expect(merged).toMatchObject({ page: 2, totalCount: 252, hasMore: true });
    expect(cache.getHistory("repo", 1)?.runs).toHaveLength(6);
    expect(cache.getHistory("repo", 2)).toBeUndefined();
  });

  it("caches only completed attempts and forgets the latest-attempt shortcut once a run re-runs", () => {
    const cache = new RepositoryViewCache();
    cache.putInspection("repo", inspection({ status: "in_progress", conclusion: null }));
    expect(cache.getInspection("repo", 7)).toBeUndefined();

    cache.putInspection("repo", inspection());
    expect(cache.getInspection("repo", 7)?.attempt).toBe(1);
    expect(cache.getInspection("repo", 7, 1)?.attempt).toBe(1);

    // A refresh shows the run running again as attempt 2: the explicit attempt stays cached, "latest" does not.
    cache.setDashboard("repo", "user", {}, [makeRun({ id: 7, status: "in_progress", conclusion: null, attemptCount: 2 })]);
    expect(cache.getInspection("repo", 7)).toBeUndefined();
    expect(cache.getInspection("repo", 7, 1)?.attempt).toBe(1);

    cache.putInspection("repo", inspection({ attempt: 2, attemptCount: 2 }));
    expect(cache.getInspection("repo", 7)?.attempt).toBe(2);
    cache.invalidateRun("repo", 7);
    expect(cache.getInspection("repo", 7)).toBeUndefined();
  });

  it("caches logs only for finished jobs whose log was retrieved", () => {
    const cache = new RepositoryViewCache();
    cache.putLog("repo", 7, false, log());
    cache.putLog("repo", 7, true, log({ availability: "expired" }));
    expect(cache.getLog("repo", 7, 1, 3)).toBeUndefined();
    cache.putLog("repo", 7, true, log(), 2);
    expect(cache.getLog("repo", 7, 1, 3, 2)?.text).toBe("ok");
    expect(cache.getLog("repo", 7, 1, 3)).toBeUndefined();
  });

  it("clears everything for one repository on identity change", () => {
    const cache = new RepositoryViewCache();
    for (const repo of ["repo", "other"]) {
      cache.setDashboard(repo, "user", {});
      cache.putHistoryPage(repo, 1, 1, { runs: [makeRun()], totalCount: 1 });
      cache.putInspection(repo, inspection());
      cache.putLog(repo, 7, true, log());
    }
    cache.clear("repo");
    expect(cache.getDashboard("repo", "user")).toBeUndefined();
    expect(cache.getHistory("repo", 1)).toBeUndefined();
    expect(cache.getInspection("repo", 7)).toBeUndefined();
    expect(cache.getLog("repo", 7, 1, 3)).toBeUndefined();
    expect(cache.getDashboard("other", "user")).toBeDefined();
    expect(cache.getInspection("other", 7)).toBeDefined();
    expect(cache.getLog("other", 7, 1, 3)).toBeDefined();
  });
});

describe("settings card cache", () => {
  it("keeps stable results per identity and ignores transient failures", () => {
    const cache = new RepositoryViewCache(() => 1_000);
    const loaded = { card: "runners", state: "loaded", refreshedAt: "t", pollingNote: "", runners: [] } as const;
    cache.setSettingsCard("repo", "u1", loaded);
    cache.setSettingsCard("repo", "u1", { card: "runners", state: "rate_limited", refreshedAt: "t2" });
    expect(cache.getSettings("repo", "u1")).toEqual({ runners: loaded });
    expect(cache.getSettings("repo", "u2")).toEqual({});
    cache.clear("repo");
    expect(cache.getSettings("repo", "u1")).toEqual({});
  });
});
