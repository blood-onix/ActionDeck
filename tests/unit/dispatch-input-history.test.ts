import { describe, expect, it } from "vitest";
import { DispatchInputHistory, MAX_STORED_DISPATCH_INPUTS } from "../../src/application/dispatch/dispatch-input-history";
import { RepositoryState, type StateStore } from "../../src/persistence/workspace-state";

function memoryStore(): StateStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

describe("dispatch input history", () => {
  it("records inputs per run, including inputs with credential-like names", async () => {
    const history = new DispatchInputHistory(new RepositoryState(memoryStore(), "repo"), () => 1);
    expect(await history.record(5, "feature/x", { packageName: "storefront-api", api_token_name: "deploy" })).toBe(true);
    expect(history.get(5)).toEqual({
      ref: "feature/x",
      inputs: [{ name: "packageName", value: "storefront-api" }, { name: "api_token_name", value: "deploy" }],
      recordedAt: 1,
    });
    expect(history.get(6)).toBeUndefined();
  });

  it("skips values the state store refuses and keeps only the newest runs", async () => {
    let now = 0;
    const history = new DispatchInputHistory(new RepositoryState(memoryStore(), "repo"), () => ++now);
    expect(await history.record(1, "main", { secret: "token=abc" })).toBe(false);
    expect(history.get(1)).toBeUndefined();
    for (let runId = 1; runId <= MAX_STORED_DISPATCH_INPUTS + 1; runId++) await history.record(runId, "main", {});
    expect(history.get(1)).toBeUndefined();
    expect(history.get(MAX_STORED_DISPATCH_INPUTS + 1)).toBeDefined();
  });
});
