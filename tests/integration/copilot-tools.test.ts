import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Copilot tools registration & disposal", () => {
  test("registers read-only and guarded execution tools when vscode.lm is available", async () => {
    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension);
    await extension.activate();
    if (vscode.lm && Array.isArray(vscode.lm.tools)) {
      const names = vscode.lm.tools.map((t) => t.name);
      assert.ok(names.includes("actiondeck_list_workflows"));
      assert.ok(names.includes("actiondeck_inspect_plan"));
      assert.ok(names.includes("actiondeck_dispatch_workflow"));
    }
  });
});
