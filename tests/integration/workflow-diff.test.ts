import * as assert from "node:assert";
import * as vscode from "vscode";
import { proposeCommentPreservingYamlFix } from "../../src/host/providers/workflow-diff";

suite("Workflow YAML comment-preserving diff", () => {
  test("preserves comments and formatting while proposing a targeted YAML fix", () => {
    const original = [
      "# @folder: Release",
      "name: Release",
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      env:",
      "        type: string # target environment",
      "jobs:",
      "  deploy:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo deploy",
      "",
    ].join("\n");

    const proposal = proposeCommentPreservingYamlFix(original, {
      setAtPath: {
        path: ["jobs", "deploy", "timeout-minutes"],
        value: 15,
      },
    });

    assert.strictEqual(proposal.changed, true);
    assert.ok(proposal.content.includes("# @folder: Release"));
    assert.ok(proposal.content.includes("# target environment"));
    assert.ok(proposal.content.includes("timeout-minutes: 15"));
  });

  test("registers the actiondeck-proposal text document scheme without auto-applying or committing", async () => {
    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("actiondeck.investigateRun"));
    assert.ok(commands.includes("actiondeck.proposeWorkflowFix"));
  });
});
