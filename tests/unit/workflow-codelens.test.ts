import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  CodeLens: class {
    constructor(readonly range: unknown, readonly command?: unknown) {}
  },
  Range: class {
    constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
}));

import { isWorkflowDocument, WorkflowCodeLensProvider } from "../../src/host/providers/workflow-codelens";

describe("workflow CodeLens", () => {
  it("provides at most 3 lenses in exact order with Title Case status word and Push-to-enable gating for local_only", () => {
    const provider = new WorkflowCodeLensProvider(
      (uri) =>
        uri.path.endsWith("release.yml")
          ? { status: "completed", conclusion: "success", updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }
          : undefined,
      (uri) => (uri.path.endsWith("local.yml") ? "local_only" : "synced"),
    );
    const workflow = {
      languageId: "yaml",
      uri: { path: "/workspace/.github/workflows/release.yml" },
    };
    expect(isWorkflowDocument(workflow as never)).toBe(true);
    const lenses = provider.provideCodeLenses(workflow as never);
    expect(lenses).toHaveLength(3);
    expect(lenses.map((lens) => lens.command)).toEqual([
      { title: "▶ Trigger workflow", command: "actiondeck.openCompanion", arguments: [workflow.uri] },
      { title: "Open companion", command: "actiondeck.openCompanion", arguments: [workflow.uri] },
      { title: "Last run: ✓ Success · 3h ago", command: "actiondeck.openLatestWorkflowRun", arguments: [workflow.uri] },
    ]);

    const localOnly = {
      languageId: "yaml",
      uri: { path: "/workspace/.github/workflows/local.yml" },
    };
    const localLenses = provider.provideCodeLenses(localOnly as never);
    expect(localLenses).toHaveLength(3);
    expect(localLenses[0]?.command?.title).toBe("Push to enable trigger");
    expect(localLenses[2]?.command?.title).toBe("Last run: Not Loaded");

    expect(provider.provideCodeLenses({
      languageId: "yaml",
      uri: { path: "/workspace/config/settings.yml" },
    } as never)).toEqual([]);
    expect(provider.provideCodeLenses({
      languageId: "json",
      uri: { path: "/workspace/.github/workflows/release.json" },
    } as never)).toEqual([]);
    expect(isWorkflowDocument({
      languageId: "yaml",
      uri: { path: "/workspace/.github/workflows/release.yaml", scheme: "vscode-remote" },
    } as never)).toBe(true);
    expect(isWorkflowDocument({
      languageId: "github-actions-workflow",
      uri: { path: "/workspace/.github/workflows/release.yml" },
    } as never)).toBe(true);
  });
});
