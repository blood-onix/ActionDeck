import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { routeMessages } from "./message-router";
import type { OperationHandler } from "./message-router";

export function createDashboardPanel(
  context: Pick<vscode.ExtensionContext, "extensionUri">,
  handlers: Record<string, OperationHandler>,
  viewColumn = vscode.ViewColumn.One,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "actiondeck.dashboard",
    "ActionDeck",
    viewColumn,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "webview", "dist")],
    },
  );
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "webview", "dist", "assets"));
  const nonce = randomBytes(16).toString("base64");
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource}; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}' ${panel.webview.cspSource};"><title>ActionDeck</title><link rel="stylesheet" href="${script}/index.css"></head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${script}/index.js"></script></body></html>`;
  const disposables: vscode.Disposable[] = [];
  routeMessages(panel, handlers, disposables);
  panel.onDidDispose(() => disposables.forEach((disposable) => disposable.dispose()));
  return panel;
}
