import { describe, expect, it } from "vitest";
import { buildDashboard } from "../../src/application/workflows/dashboard-service";
import { dashboardDataSchema } from "../../src/protocol/dashboard";
import { makeRemoteWorkflow, makeRun, makeWorkflow } from "../fixtures/fakes";

describe("dashboard projection contract", () => {
  it("accepts bounded workflow states and preserves unknown run-history distinctions", () => {
    const projection = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [
      makeWorkflow(1),
      makeWorkflow(2),
      makeWorkflow(3, { diagnostic: "Malformed YAML" }),
      makeWorkflow(4),
    ], [
      makeRemoteWorkflow(1),
      makeRemoteWorkflow(2, { state: "disabled_inactivity" }),
      makeRemoteWorkflow(5),
    ], [makeRun({ id: 8, workflowId: 1 })], false);

    expect(dashboardDataSchema.parse(projection).workflows.map((workflow) => workflow.availability))
      .toEqual(expect.arrayContaining(["synced", "disabled", "local_only", "remote_only"]));
    expect(dashboardDataSchema.parse(projection).workflows.find((workflow) => workflow.workflowId === 2)?.availability)
      .toBe("disabled");
  });

  it("rejects fabricated availability values and oversized dashboard collections", () => {
    const base = {
      repository: { owner: "acme", repo: "demo", authenticatedUserId: "" },
      workflows: [{
        id: "wf",
        name: "Build",
        path: ".github/workflows/build.yml",
        folder: "CI",
        availability: "unknown",
        status: "—",
        title: "—",
        branch: "—",
        actor: "—",
        isMyRun: false,
        duration: "Not available",
        metrics: {
          passes: 0,
          failures: 0,
          sampleSize: 0,
          scope: "last 0 observed completed runs",
          passRate: null,
          averageDurationMs: null,
        },
      }],
    };
    expect(dashboardDataSchema.safeParse(base).success).toBe(false);
    expect(dashboardDataSchema.safeParse({
      repository: base.repository,
      workflows: Array.from({ length: 10_001 }, () => ({
        ...base.workflows[0],
        availability: "run_info_not_loaded",
      })),
    }).success).toBe(false);
  });

  it("preserves restricted run history separately from a zero-run result", () => {
    const projection = buildDashboard({
      id: "repo",
      owner: "acme",
      repo: "demo",
      remoteName: "origin",
      workspaceFolderUri: "file:///repo",
    }, [makeWorkflow(1)], [makeRemoteWorkflow(1)], [], true, "access_restricted");
    const result = dashboardDataSchema.parse(projection);
    expect(result.workflows[0]).toMatchObject({
      availability: "access_restricted",
      historyHydration: "restricted",
      metrics: { sampleSize: 0 },
    });
  });
});
