import * as assert from "node:assert";
import * as vscode from "vscode";

suite("ActionDeck activation", () => {
  test("registers dashboard and repository commands", async () => {
    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension, "development extension should be available");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("actiondeck.openDashboard"));
    assert.ok(commands.includes("actiondeck.selectRepository"));
  });
});
