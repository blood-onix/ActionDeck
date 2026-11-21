import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private readonly callback: () => void) {}
    dispose() { this.callback(); }
  },
}));

import { routeMessages } from "../../src/host/webviews/message-router";

function createPanel() {
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const posts: unknown[] = [];
  const panel = {
    webview: {
      onDidReceiveMessage(callback: (message: unknown) => Promise<void>) {
        receive = callback;
        return { dispose() {} };
      },
      async postMessage(message: unknown) {
        posts.push(message);
        return true;
      },
    },
  };
  return {
    panel,
    posts,
    receive: (message: unknown) => {
      if (!receive) throw new Error("Message listener was not registered");
      return receive(message);
    },
  };
}

describe("host message router", () => {
  it("returns one correlated cancellation response when a request is cancelled", async () => {
    const { panel, posts, receive } = createPanel();
    const disposables: Array<{ dispose(): void }> = [];
    routeMessages(panel as never, {
      "dashboard.load": async (_payload, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ stale: true }));
      }),
    }, disposables as never);

    const requestId = "cancel-me";
    const request = receive({
      version: 1, type: "request", requestId, operation: "dashboard.load", payload: {},
    });
    await receive({
      version: 1, type: "request", requestId, operation: "unknown.operation", payload: {},
    });
    await receive({ version: 1, type: "cancel", requestId });
    await request;
    expect(posts).toEqual([{
      version: 1,
      type: "response",
      requestId,
      ok: false,
      error: { code: "cancelled", message: "ActionDeck request was cancelled.", retryable: false },
    }]);
  });

  it("aborts pending work on disposal and suppresses late panel responses", async () => {
    const { panel, posts, receive } = createPanel();
    const disposables: Array<{ dispose(): void }> = [];
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    routeMessages(panel as never, {
      "dashboard.load": async (_payload, requestSignal) => {
        signal = requestSignal;
        await new Promise<void>((resolve) => { release = resolve; });
        return { loaded: true };
      },
    }, disposables as never);

    const request = receive({
      version: 1, type: "request", requestId: "dispose", operation: "dashboard.load", payload: {},
    });
    await Promise.resolve();
    disposables[1]?.dispose();
    release?.();
    await request;
    expect(signal?.aborted).toBe(true);
    expect(posts).toEqual([]);
  });
});
