import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatchRepository } from "../../src/github/repositories/dispatch-repository";
import { RepositoryScheduler } from "../../src/github/rate-limit/repository-scheduler";

afterEach(() => vi.unstubAllGlobals());

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileResponse(source: string): Response {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(source).toString("base64"),
  });
}

function pathOf(input: RequestInfo | URL): string {
  const url = new URL(typeof input === "string" ? input : input.toString());
  return decodeURIComponent(url.pathname);
}

describe("dispatch repository", () => {
  it("loads the workflow definition for a selected remote ref after verifying the default branch", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/repos/acme/demo") return jsonResponse({ default_branch: "main" });
      if (path === "/repos/acme/demo/actions/workflows/7") {
        return jsonResponse({ id: 7, path: ".github/workflows/release.yml", state: "active" });
      }
      if (path === "/repos/acme/demo/contents/.github/workflows/release.yml") {
        return fileResponse("on:\n  workflow_dispatch:\n    inputs:\n      version:\n        type: number\n        required: true\n");
      }
      throw new Error(`Unexpected GitHub request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    const scheduler = new RepositoryScheduler(2);
    const repository = new DispatchRepository(scheduler, context, "test-token");

    try {
      const target = await repository.loadTarget(7, "release");
      expect(target).toMatchObject({
        state: "available",
        workflowId: 7,
        workflowPath: ".github/workflows/release.yml",
        ref: "release",
        defaultBranch: "main",
        inputs: [{ name: "version", type: "number", sourceRef: "release" }],
      });
      const contentsRequests = fetch.mock.calls
        .map(([input]) => new URL(typeof input === "string" ? input : input.toString()))
        .filter((url) => decodeURIComponent(url.pathname).includes("/contents/"));
      expect(contentsRequests).toHaveLength(2);
      expect(contentsRequests.map((url) => url.searchParams.get("ref")).sort()).toEqual(["main", "release"]);
    } finally {
      scheduler.dispose();
    }
  });

  it("blocks workflows that cannot be confirmed on the default branch", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/repos/acme/demo") return jsonResponse({ default_branch: "main" });
      if (path === "/repos/acme/demo/actions/workflows/7") {
        return jsonResponse({ id: 7, path: ".github/workflows/release.yml", state: "active" });
      }
      return jsonResponse({ message: "Not Found" }, 404);
    });
    vi.stubGlobal("fetch", fetch);
    const scheduler = new RepositoryScheduler(2);
    const repository = new DispatchRepository(scheduler, context, "test-token");

    try {
      await expect(repository.loadTarget(7, "release")).resolves.toMatchObject({
        state: "blocked",
        reason: "The workflow is missing or inaccessible on the repository default branch.",
      });
    } finally {
      scheduler.dispose();
    }
  });

  it("offers validated manual environment entry when environment listing is restricted", async () => {
    const fetch = vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403));
    vi.stubGlobal("fetch", fetch);
    const scheduler = new RepositoryScheduler(2);
    const repository = new DispatchRepository(scheduler, context, "test-token");

    try {
      await expect(repository.listEnvironments()).resolves.toMatchObject({
        state: "permission_restricted",
        manualEntryAllowed: true,
      });
    } finally {
      scheduler.dispose();
    }
  });

  it("does not automatically retry a workflow dispatch mutation", async () => {
    const fetch = vi.fn(async () => jsonResponse({ message: "Internal Server Error" }, 500));
    vi.stubGlobal("fetch", fetch);
    const scheduler = new RepositoryScheduler(2);
    const repository = new DispatchRepository(scheduler, context, "test-token");

    try {
      await expect(repository.submit(7, "release", { version: "2.0" })).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledOnce();
      const requestInit = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(requestInit?.method).toBe("POST");
      expect(requestInit?.body).toContain('"version":"2.0"');
    } finally {
      scheduler.dispose();
    }
  });

  it("pages remote branches 100 at a time and stops on a short page", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ name: `feature-${i}` })),
      [{ name: "main" }, { name: "release" }],
    ];
    const fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(pages[page - 1] ?? []);
    });
    vi.stubGlobal("fetch", fetch);
    const scheduler = new RepositoryScheduler(2);
    const repository = new DispatchRepository(scheduler, context, "test-token");
    try {
      const branches = await repository.listBranches();
      expect(branches.truncated).toBe(false);
      expect(branches.names).toHaveLength(102);
      expect(branches.names.slice(-2)).toEqual(["main", "release"]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.dispose();
    }
  });
});
