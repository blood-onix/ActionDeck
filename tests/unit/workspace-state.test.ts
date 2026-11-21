import { describe, expect, it } from "vitest";
import { GlobalPreferences, RepositoryState, type StateStore } from "../../src/persistence/workspace-state";

class MemoryState implements StateStore {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe("scoped state adapters", () => {
  it("uses versioned repository and global-preference namespaces", async () => {
    const state = new MemoryState();
    const repository = new RepositoryState(state, "acme/demo");
    const preferences = new GlobalPreferences(state);
    await repository.update("subscriptions", { build: "failures" });
    await preferences.update("theme", "dark");
    expect(state.values.has("actiondeck.v1:repository:acme/demo:subscriptions")).toBe(true);
    expect(state.values.has("actiondeck.v1:preferences:theme")).toBe(true);
    expect(repository.get("subscriptions")).toEqual({ build: "failures" });
    expect(preferences.get("theme")).toBe("dark");
  });

  it("rejects authentication and log data before persistence", () => {
    const state = new MemoryState();
    const repository = new RepositoryState(state, "acme/demo");
    expect(() => repository.update("settings", { accessToken: "secret" })).toThrow(
      "Authentication data and log content cannot be persisted.",
    );
    expect(() => repository.update("jobLog", "build completed")).toThrow(
      "Authentication data and log content cannot be persisted.",
    );
    expect(() => repository.update("settings", { value: "API_KEY=example" })).toThrow(
      "Values containing credential assignments cannot be persisted.",
    );
    expect(state.values.size).toBe(0);
  });
});
