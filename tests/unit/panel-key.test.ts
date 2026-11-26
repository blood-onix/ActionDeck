import { describe, expect, it } from "vitest";
import { dashboardPanelKey } from "../../src/host/webviews/panel-key";

describe("dashboard panel key", () => {
  const repo = "acme/demo|origin|file:///repo";

  it("gives the same key to the same surface of the same repository", () => {
    expect(dashboardPanelKey(repo, {})).toBe(dashboardPanelKey(repo, {}));
    expect(dashboardPanelKey(repo, { initialRunId: 7 })).toBe(dashboardPanelKey(repo, { initialRunId: 7 }));
    expect(dashboardPanelKey(repo, { workflowPath: ".github/workflows/CI.yml", initialAction: "pipeline" }))
      .toBe(dashboardPanelKey(repo, { workflowPath: ".github/workflows/ci.yml", initialAction: "pipeline" }));
  });

  it("separates repositories and surfaces", () => {
    const keys = new Set([
      dashboardPanelKey(repo, {}),
      dashboardPanelKey("acme/other|origin|file:///other", {}),
      dashboardPanelKey(repo, { initialRunId: 7 }),
      dashboardPanelKey(repo, { initialRunId: 8 }),
      dashboardPanelKey(repo, { initialView: "action-center" }),
      dashboardPanelKey(repo, { workflowPath: ".github/workflows/ci.yml", initialAction: "companion" }),
      dashboardPanelKey(repo, { workflowPath: ".github/workflows/ci.yml", initialAction: "pipeline" }),
      dashboardPanelKey(repo, { workflowPath: ".github/workflows/ci.yml", initialAction: "latest-run" }),
    ]);
    expect(keys.size).toBe(8);
  });
});
