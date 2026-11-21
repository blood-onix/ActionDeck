import * as assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { inspectLocalWorkflowPreview } from "../../src/application/workflows/local-preview";
import { isWorkflowDocument } from "../../src/host/providers/workflow-codelens";

suite("ActionDeck workflow Companion entry points", () => {
  test("registers editor commands and title-menu contributions", async () => {
    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("actiondeck.openCompanion"));
    assert.ok(commands.includes("actiondeck.openLatestWorkflowRun"));

    const activationEvents = extension.packageJSON.activationEvents as readonly string[] | undefined;
    assert.ok(activationEvents?.includes("workspaceContains:.github/workflows/*.{yml,yaml}"));
    assert.ok(activationEvents?.includes("onLanguage:yaml"));

    const menus = extension.packageJSON.contributes.menus as
      | Record<string, readonly { command: string }[]>
      | undefined;
    const editorTitle = menus?.["editor/title"] ?? [];
    assert.ok(editorTitle.some((item) => item.command === "actiondeck.openCompanion"));
    assert.ok(editorTitle.some((item) => item.command === "actiondeck.openLatestWorkflowRun"));
    assert.ok(commands.includes("actiondeck.openPipeline"));
    assert.ok(commands.includes("actiondeck.openRepositoryDeck"));
    const explorerContext = menus?.["explorer/context"] ?? [];
    for (const command of ["actiondeck.openPipeline", "actiondeck.openLatestWorkflowRun", "actiondeck.openCompanion"]) {
      assert.ok(explorerContext.some((item) => item.command === command), command);
    }
  });

  test("provides CodeLens for a workflow file and observes unsaved document edits", async () => {
    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension);
    await extension.activate();

    const root = await mkdtemp(join(tmpdir(), "actiondeck-companion-"));
    try {
      const directory = join(root, ".github", "workflows");
      await mkdir(directory, { recursive: true });
      const file = join(directory, "release.yml");
      await writeFile(file, "name: Release\non:\n  workflow_dispatch:\n");
      let document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      for (const language of ["yaml", "json"]) {
        document = await vscode.languages.setTextDocumentLanguage(document, language);
        const lenses = await vscode.commands.executeCommand<readonly vscode.CodeLens[]>(
          "vscode.executeCodeLensProvider",
          document.uri,
        );
        assert.deepStrictEqual(lenses?.map((lens) => lens.command?.title), [
          "▶ Trigger workflow",
          "Open companion",
          "Last run: Not Loaded",
        ]);
      }

      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(document.getText().length), "    inputs:\n      version:\n        type: string\n");
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(document.getText().includes("version:"));
      assert.deepStrictEqual(
        inspectLocalWorkflowPreview(".github/workflows/release.yml", document.getText()).inputs?.map((input) => input.name),
        ["version"],
      );
      assert.strictEqual(isWorkflowDocument({
        languageId: "yaml",
        uri: vscode.Uri.parse("vscode-remote://ssh-remote+host/workspace/.github/workflows/release.yaml"),
      } as vscode.TextDocument), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
