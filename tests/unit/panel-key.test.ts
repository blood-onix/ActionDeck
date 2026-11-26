import { describe, expect, it } from "vitest";
import { dashboardPanelKey } from "../../src/host/webviews/panel-key";

describe("dashboard panel key", () => {
  const repo = "acme/demo|origin|file:///repo";

  it("gives the same key to the same surface of the same repository", () => {
    expect(dashboardPanelKey(repo, "1", {})).toBe(dashboardPanelKey(repo, "1", {}));
    expect(dashboardPanelKey(repo, "1", { initialRunId: 7 })).toBe(dashboardPanelKey(repo, "1", { initialRunId: 7 }));
    expect(dashboardPanelKey(repo, "1", { workflowPath: ".github/workflows/CI.yml", initialAction: "pipeline" }))
      .toBe(dashboardPanelKey(repo, "1", { workflowPath: ".github/workflows/ci.yml", initialAction: "pipeline" }));
  });

  it("separates repositories and surfaces", () => {
    const keys = new Set([
      dashboardPanelKey(repo, "1", {}),
      dashboardPanelKey("acme/other|origin|file:///other", "1", {}),
      dashboardPanelKey(repo, "1", { initialRunId: 7 }),
      dashboardPanelKey(repo, "1", { initialRunId: 8 }),
      dashboardPanelKey(repo, "1", { initialView: "action-center" }),
      dashboardPanelKey(repo, "1", { workflowPath: ".github/workflows/ci.yml", initialAction: "companion" }),
      dashboardPanelKey(repo, "1", { workflowPath: ".github/workflows/ci.yml", initialAction: "pipeline" }),
      dashboardPanelKey(repo, "1", { workflowPath: ".github/workflows/ci.yml", initialAction: "latest-run" }),
    ]);
    expect(keys.size).toBe(8);
  });

  it("does not reuse a tab bound to a different GitHub identity", () => {
    expect(dashboardPanelKey(repo, "1", {})).not.toBe(dashboardPanelKey(repo, "2", {}));
  });
});
