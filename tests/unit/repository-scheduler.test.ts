import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryScheduler } from "../../src/github/rate-limit/repository-scheduler";

afterEach(() => vi.useRealTimers());

describe("repository scheduler", () => {
  it("deduplicates concurrent requests within a repository", async () => {
    const scheduler = new RepositoryScheduler(2);
    let calls = 0;
    let release: ((value: number) => void) | undefined;
    const operation = () => {
      calls++;
      return new Promise<number>((resolve) => { release = resolve; });
    };
    const first = scheduler.schedule("repo", "runs", operation);
    const second = scheduler.schedule("repo", "runs", operation);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    release?.(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    scheduler.dispose();
  });

  it("never exceeds the configured concurrency", async () => {
    const scheduler = new RepositoryScheduler(2);
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      scheduler.schedule("repo", String(index), async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
      }),
    ));
    expect(maximum).toBe(2);
    scheduler.dispose();
  });

  it("caches bounded results and invalidates repository data", async () => {
    const scheduler = new RepositoryScheduler();
    const first = await scheduler.schedule("repo", "runs", async () => 1, { cacheTtlMs: 1_000 });
    const cached = await scheduler.schedule("repo", "runs", async () => 2, { cacheTtlMs: 1_000 });
    scheduler.invalidate("repo", "runs");
    const refreshed = await scheduler.schedule("repo", "runs", async () => 3, { cacheTtlMs: 1_000 });
    expect([first, cached, refreshed]).toEqual([1, 1, 3]);
    scheduler.dispose();
  });

  it("rejects an in-flight result invalidated by a repository change", async () => {
    const scheduler = new RepositoryScheduler();
    let release: ((value: number) => void) | undefined;
    const pending = scheduler.schedule("repo", "runs", () => new Promise<number>((resolve) => {
      release = resolve;
    }));
    await Promise.resolve();
    await Promise.resolve();
    scheduler.invalidate("repo");
    release?.(7);
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    scheduler.dispose();
  });

  it("waits for repository rate-limit backoff without blocking unrelated repositories", async () => {
    vi.useFakeTimers();
    const scheduler = new RepositoryScheduler(1);
    scheduler.defer("limited", 1_000);
    const limitedOperation = vi.fn(async () => "ready");
    const limited = scheduler.schedule("limited", "runs", limitedOperation);
    const other = scheduler.schedule("other", "runs", async () => "independent");
    await expect(other).resolves.toBe("independent");
    expect(limitedOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(limited).resolves.toBe("ready");
    scheduler.dispose();
  });

  it("pauses dashboard leases while hidden but keeps background leases active", async () => {
    const scheduler = new RepositoryScheduler();
    const dashboard = scheduler.createLease("repo", "dashboard");
    const background = scheduler.createLease("repo", "background", false);
    dashboard.setVisible(false);
    await expect(scheduler.schedule("repo", "dashboard", async () => true, { lease: dashboard }))
      .rejects.toMatchObject({ code: "cancelled" });
    await expect(scheduler.schedule("repo", "background", async () => true, { lease: background }))
      .resolves.toBe(true);
    scheduler.dispose();
    expect(background.isActive()).toBe(false);
  });

  it("rejects rate-limit waits when disposed", async () => {
    vi.useFakeTimers();
    const scheduler = new RepositoryScheduler();
    scheduler.defer("repo", 60_000);
    const pending = scheduler.schedule("repo", "runs", async () => true);
    await Promise.resolve();
    scheduler.dispose();
    await expect(pending).rejects.toThrow("Repository scheduler is disposed");
  });

  it("cancels work while queued or waiting on rate limits", async () => {
    const scheduler = new RepositoryScheduler(1);
    let release: (() => void) | undefined;
    const first = scheduler.schedule("repo", "active", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await Promise.resolve();
    await Promise.resolve();
    const queuedController = new AbortController();
    const queuedOperation = vi.fn(async () => true);
    const queued = scheduler.schedule("repo", "queued", queuedOperation, { signal: queuedController.signal });
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    release?.();
    await first;
    expect(queuedOperation).not.toHaveBeenCalled();
    scheduler.dispose();

    vi.useFakeTimers();
    const delayedScheduler = new RepositoryScheduler();
    delayedScheduler.defer("repo", 60_000);
    const delayedController = new AbortController();
    const delayedOperation = vi.fn(async () => true);
    const delayed = delayedScheduler.schedule("repo", "delayed", delayedOperation, {
      signal: delayedController.signal,
    });
    await Promise.resolve();
    delayedController.abort();
    await expect(delayed).rejects.toMatchObject({ code: "cancelled" });
    expect(delayedOperation).not.toHaveBeenCalled();
    delayedScheduler.dispose();
  });
});
