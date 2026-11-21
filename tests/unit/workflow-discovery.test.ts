import { describe, expect, it } from "vitest";
import { buildDashboard } from "../../src/application/workflows/dashboard-service";
import { inspectWorkflowYaml } from "../../src/domain/services/workflow-parser";
import { workflowFolder } from "../../src/domain/services/workflow-folders";
import { makeRemoteWorkflow, makeRun, makeWorkflow } from "../fixtures/fakes";
import { workflowYamlFixtures } from "../fixtures/workflows";

describe("workflow discovery projections", () => {
  it("reconciles by normalized path and preserves local-only and remote-only entries", () => {
    const data = buildDashboard(
      { id: "acme/demo|origin|file:///repo", owner: "acme", repo: "demo", remoteName: "origin", workspaceFolderUri: "file:///repo" },
      [
        makeWorkflow(1, { path: ".github\\workflows\\workflow-1.yml" }),
        makeWorkflow(3),
      ],
      [
        makeRemoteWorkflow(1, { path: "/.github/workflows/workflow-1.yml" }),
        makeRemoteWorkflow(2),
      ],
      [makeRun({ id: 100, workflowId: 1 })],
      false,
    );
    expect(data.workflows).toHaveLength(3);
    expect(data.workflows.find((workflow) => workflow.id === "1")?.availability).toBe("synced");
    expect(data.workflows.find((workflow) => workflow.id === "2")?.availability).toBe("remote_only");
    expect(data.workflows.find((workflow) => workflow.path.endsWith("workflow-3.yml"))?.availability).toBe("local_only");
  });

  it("does not infer never-run from a bounded repository run page", () => {
    const data = buildDashboard(
      { id: "repo", owner: "acme", repo: "demo", remoteName: "origin", workspaceFolderUri: "file:///repo" },
      [makeWorkflow(1), makeWorkflow(2)],
      [makeRemoteWorkflow(1), makeRemoteWorkflow(2)],
      [makeRun({ id: 100, workflowId: 1 })],
      false,
    );
    expect(data.workflows.find((workflow) => workflow.workflowId === 2)?.availability).toBe("run_info_not_loaded");
    expect(data.workflows.find((workflow) => workflow.workflowId === 2)?.availability).not.toBe("never_run");
  });

  it("treats a truncated run page as synced, not stale, and shows no warning", () => {
    const data = buildDashboard(
      { id: "repo", owner: "acme", repo: "demo", remoteName: "origin", workspaceFolderUri: "file:///repo" },
      [makeWorkflow(1), makeWorkflow(2)],
      [makeRemoteWorkflow(1), makeRemoteWorkflow(2)],
      [makeRun({ id: 100, workflowId: 1 })],
      true,
    );
    expect(data.workflows.find((workflow) => workflow.workflowId === 1)?.availability).toBe("synced");
    expect(data.workflows.find((workflow) => workflow.workflowId === 2)?.availability).toBe("run_info_not_loaded");
    expect(data.warning).toBeUndefined();
    expect(data.warningKind).toBeUndefined();
  });

  it("reports stale only when the history load actually failed", () => {
    const data = buildDashboard(
      { id: "repo", owner: "acme", repo: "demo", remoteName: "origin", workspaceFolderUri: "file:///repo" },
      [makeWorkflow(1)],
      [makeRemoteWorkflow(1)],
      [],
      false,
      "partial_stale",
    );
    expect(data.workflows[0]?.availability).toBe("partial_stale");
    expect(data.warningKind).toBe("stale");
    expect(data.warning).toMatch(/could not be refreshed/);
  });

  it("isolates malformed YAML and detects workflow_dispatch with YAML 1.2 on-key semantics", () => {
    expect(inspectWorkflowYaml(workflowYamlFixtures.workflowDispatch).dispatchable).toBe(true);
    expect(inspectWorkflowYaml(workflowYamlFixtures.pushOnly).dispatchable).toBe(false);
    expect(inspectWorkflowYaml(workflowYamlFixtures.malformed).diagnostic).toBeTruthy();
  });

  it("flags workflow_call-only files as reusable templates", () => {
    expect(inspectWorkflowYaml(workflowYamlFixtures.reusableOnly).reusable).toBe(true);
    expect(inspectWorkflowYaml(workflowYamlFixtures.reusableScalar).reusable).toBe(true);
    expect(inspectWorkflowYaml(workflowYamlFixtures.reusableAndDispatch).reusable).toBe(false);
    expect(inspectWorkflowYaml(workflowYamlFixtures.pushOnly).reusable).toBe(false);
    expect(inspectWorkflowYaml(workflowYamlFixtures.malformed).reusable).toBe(false);
  });

  it("hides reusable templates from the dashboard even when GitHub lists them", () => {
    const data = buildDashboard(
      { id: "repo", owner: "acme", repo: "demo", remoteName: "origin", workspaceFolderUri: "file:///repo" },
      [makeWorkflow(1), makeWorkflow(2, { reusable: true })],
      [makeRemoteWorkflow(1), makeRemoteWorkflow(2)],
      [],
      false,
    );
    expect(data.workflows.map((workflow) => workflow.workflowId)).toEqual([1]);
  });

  it("uses leading annotation before configured filename prefixes", () => {
    expect(workflowFolder(workflowYamlFixtures.annotatedFolder, "deploy-prod.yml", ["deploy-"])).toBe("Release/Deploy");
    expect(workflowFolder(workflowYamlFixtures.prefixed, "deploy-prod.yml", ["deploy-"])).toBe("deploy");
    expect(workflowFolder("name: deploy\n", "test.yml", ["deploy-"])).toBe("Ungrouped");
    expect(workflowFolder(workflowYamlFixtures.invalidAnnotation, "deploy-prod.yml", ["deploy-"])).toBe("deploy");
  });
});
