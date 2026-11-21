import * as assert from "node:assert";
import * as vscode from "vscode";
import { createDashboardPanel } from "../../src/host/webviews/panel-factory";

suite("ActionDeck dashboard panel", () => {
  test("opens a script-enabled panel with packaged assets and a restrictive CSP", () => {
    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension);
    const panel = createDashboardPanel({ extensionUri: extension.extensionUri }, {
      "dashboard.load": async () => ({ workflows: [] }),
    });
    try {
      assert.strictEqual(panel.viewType, "actiondeck.dashboard");
      assert.strictEqual(panel.title, "ActionDeck");
      assert.strictEqual(panel.webview.options.enableScripts, true);
      assert.deepStrictEqual(panel.webview.options.localResourceRoots, [
        vscode.Uri.joinPath(extension.extensionUri, "webview", "dist"),
      ]);
      assert.match(panel.webview.html, /default-src 'none'/);
      assert.match(panel.webview.html, /script-src 'nonce-[^']+'/);
      assert.match(panel.webview.html, /webview\/dist\/assets\/index\.js/);
      assert.doesNotMatch(panel.webview.html, /unsafe-inline/);
    } finally {
      panel.dispose();
    }
  });
});
