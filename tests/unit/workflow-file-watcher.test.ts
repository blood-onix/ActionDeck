import { afterEach, describe, expect, it, vi } from "vitest";
import { watchWorkflowFiles } from "../../src/host/providers/workflow-file-watcher";

afterEach(() => vi.useRealTimers());

describe("workflow file watcher", () => {
  it("debounces YAML create/change/delete events and ignores unrelated files", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (uri: { path: string }) => void>();
    const watcher = {
      onDidCreate: vi.fn((listener: (uri: { path: string }) => void) => {
        listeners.set("create", listener);
        return { dispose: vi.fn() };
      }),
      onDidChange: vi.fn((listener: (uri: { path: string }) => void) => {
        listeners.set("change", listener);
        return { dispose: vi.fn() };
      }),
      onDidDelete: vi.fn((listener: (uri: { path: string }) => void) => {
        listeners.set("delete", listener);
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    };
    const onChange = vi.fn();
    const subscription = watchWorkflowFiles(watcher, onChange);

    listeners.get("change")?.({ path: "/repo/.github/workflows/build.yml" });
    vi.advanceTimersByTime(100);
    listeners.get("create")?.({ path: "/repo/.github/workflows/deploy.YAML" });
    vi.advanceTimersByTime(149);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledOnce();
    listeners.get("delete")?.({ path: "/repo/.github/workflows/README.md" });
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledOnce();
    subscription.dispose();
    expect(watcher.dispose).toHaveBeenCalledOnce();
  });

  it("cancels pending refresh work when disposed", () => {
    vi.useFakeTimers();
    let onChange: ((uri: { path: string }) => void) | undefined;
    const listenerDispose = vi.fn();
    const watcher = {
      onDidCreate: vi.fn((listener: (uri: { path: string }) => void) => { onChange = listener; return { dispose: listenerDispose }; }),
      onDidChange: vi.fn(() => ({ dispose: listenerDispose })),
      onDidDelete: vi.fn(() => ({ dispose: listenerDispose })),
      dispose: vi.fn(),
    };
    const callback = vi.fn();
    const subscription = watchWorkflowFiles(watcher, callback);
    onChange?.({ path: "/repo/.github/workflows/build.yml" });
    subscription.dispose();
    vi.advanceTimersByTime(200);
    expect(callback).not.toHaveBeenCalled();
    expect(listenerDispose).toHaveBeenCalledTimes(3);
  });
});
