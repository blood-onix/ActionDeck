import type * as vscode from "vscode";

type DisposableLike = { dispose(): void };
type WorkflowFileWatcher = Pick<
  vscode.FileSystemWatcher,
  "onDidCreate" | "onDidChange" | "onDidDelete" | "dispose"
>;

export function watchWorkflowFiles(
  watcher: WorkflowFileWatcher,
  onChange: () => void,
  delayMs = 150,
): DisposableLike {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listenerDisposables: DisposableLike[] = [];
  const onFileEvent = (uri: vscode.Uri) => {
    if (!/\.(?:yml|yaml)$/i.test(uri.path.split("/").pop() ?? "")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onChange();
    }, delayMs);
  };
  listenerDisposables.push(
    watcher.onDidCreate(onFileEvent),
    watcher.onDidChange(onFileEvent),
    watcher.onDidDelete(onFileEvent),
  );
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const listener of listenerDisposables) listener.dispose();
      watcher.dispose();
    },
  };
}
