import { AppError } from "../../domain/models/errors";

export interface SchedulerLease {
  readonly repositoryId: string;
  readonly kind: "dashboard" | "background";
  isActive(): boolean;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface ScheduleOptions {
  readonly cacheTtlMs?: number;
  readonly lease?: SchedulerLease;
  readonly signal?: AbortSignal;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

interface QueueWaiter {
  resolve(): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class RepositoryScheduler {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, Map<string, CacheEntry>>();
  private readonly generations = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly signalIds = new WeakMap<AbortSignal, number>();
  private readonly leases = new Set<() => void>();
  private readonly queue: QueueWaiter[] = [];
  private readonly delayWaiters = new Map<ReturnType<typeof setTimeout>, {
    reject(error: Error): void;
    cleanup(): void;
  }>();
  private active = 0;
  private nextSignalId = 0;
  private disposed = false;

  constructor(private readonly maxConcurrency = 3) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("Repository scheduler concurrency must be a positive integer.");
    }
  }

  schedule<T>(
    repositoryId: string,
    key: string,
    operation: () => Promise<T>,
    options: ScheduleOptions = {},
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Repository scheduler is disposed"));
    if (options.signal?.aborted) return Promise.reject(new AppError("cancelled", "Repository request was cancelled."));
    if (options.lease && !options.lease.isActive()) {
      return Promise.reject(new AppError("cancelled", "Repository view is no longer active."));
    }

    const repositoryCache = this.cache.get(repositoryId);
    const cached = repositoryCache?.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T);
    repositoryCache?.delete(key);

    let signalId = 0;
    if (options.signal) {
      signalId = this.signalIds.get(options.signal) ?? ++this.nextSignalId;
      this.signalIds.set(options.signal, signalId);
    }
    const requestKey = JSON.stringify([repositoryId, key, signalId]);
    const active = this.inFlight.get(requestKey);
    if (active) return active as Promise<T>;

    const generation = this.generations.get(repositoryId) ?? 0;
    const promise = this.runBounded(async () => {
      const value = await operation();
      if (this.disposed) throw new Error("Repository scheduler is disposed");
      if (generation !== (this.generations.get(repositoryId) ?? 0)) {
        throw new AppError("stale", "Repository data changed while the request was in progress.");
      }
      if (options.cacheTtlMs && options.cacheTtlMs > 0) {
        const entries = this.cache.get(repositoryId) ?? new Map<string, CacheEntry>();
        entries.set(key, { value, expiresAt: Date.now() + options.cacheTtlMs });
        this.cache.set(repositoryId, entries);
      }
      return value;
    }, repositoryId, options.lease, options.signal).finally(() => this.inFlight.delete(requestKey));
    this.inFlight.set(requestKey, promise);
    return promise;
  }

  invalidate(repositoryId: string, key?: string): void {
    this.generations.set(repositoryId, (this.generations.get(repositoryId) ?? 0) + 1);
    if (key === undefined) {
      this.cache.delete(repositoryId);
    } else {
      this.cache.get(repositoryId)?.delete(key);
    }
  }

  defer(repositoryId: string, delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0 || this.disposed) return;
    this.backoffUntil.set(repositoryId, Math.max(
      this.backoffUntil.get(repositoryId) ?? 0,
      Date.now() + Math.min(delayMs, 60 * 60 * 1000),
    ));
  }

  createLease(
    repositoryId: string,
    kind: SchedulerLease["kind"],
    initiallyVisible = true,
  ): SchedulerLease {
    let active = true;
    let visible = initiallyVisible;
    const dispose = () => {
      if (!active) return;
      active = false;
      this.leases.delete(dispose);
    };
    if (this.disposed) {
      active = false;
    } else {
      this.leases.add(dispose);
    }
    return {
      repositoryId,
      kind,
      isActive: () => active && (kind === "background" || visible),
      setVisible: (nextVisible) => { visible = nextVisible; },
      dispose,
    };
  }

  addLease(dispose: () => void): { dispose(): void } {
    if (this.disposed) {
      dispose();
      return { dispose() {} };
    }
    this.leases.add(dispose);
    return {
      dispose: () => {
        if (!this.leases.delete(dispose)) return;
        dispose();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [timer, waiter] of this.delayWaiters) {
      clearTimeout(timer);
      waiter.cleanup();
      waiter.reject(new Error("Repository scheduler is disposed"));
    }
    this.delayWaiters.clear();
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new Error("Repository scheduler is disposed"));
    }
    for (const dispose of this.leases) dispose();
    this.leases.clear();
    this.cache.clear();
    this.backoffUntil.clear();
  }

  private async runBounded<T>(
    operation: () => Promise<T>,
    repositoryId: string,
    lease?: SchedulerLease,
    signal?: AbortSignal,
  ): Promise<T> {
    while (true) {
      await this.waitForBackoff(repositoryId, signal);
      if (signal?.aborted) throw new AppError("cancelled", "Repository request was cancelled.");
      if (lease && !lease.isActive()) throw new AppError("cancelled", "Repository view is no longer active.");
      await this.acquire(signal);
      const backoffUntil = this.backoffUntil.get(repositoryId) ?? 0;
      if (backoffUntil > Date.now()) {
        this.release();
        continue;
      }
      try {
        if (signal?.aborted) throw new AppError("cancelled", "Repository request was cancelled.");
        if (lease && !lease.isActive()) throw new AppError("cancelled", "Repository view is no longer active.");
        const value = await operation();
        if (signal?.aborted) throw new AppError("cancelled", "Repository request was cancelled.");
        return value;
      } finally {
        this.release();
      }
    }
  }

  private async waitForBackoff(repositoryId: string, signal?: AbortSignal): Promise<void> {
    while (!this.disposed) {
      if (signal?.aborted) throw new AppError("cancelled", "Repository request was cancelled.");
      const remaining = (this.backoffUntil.get(repositoryId) ?? 0) - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.delayWaiters.delete(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, remaining);
        const onAbort = () => {
          clearTimeout(timer);
          this.delayWaiters.delete(timer);
          reject(new AppError("cancelled", "Repository request was cancelled."));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.delayWaiters.set(timer, {
          reject,
          cleanup: () => signal?.removeEventListener("abort", onAbort),
        });
      });
    }
    throw new Error("Repository scheduler is disposed");
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Repository scheduler is disposed"));
    if (signal?.aborted) return Promise.reject(new AppError("cancelled", "Repository request was cancelled."));
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve: () => {
          waiter.cleanup();
          resolve();
        },
        reject: (error) => {
          waiter.cleanup();
          reject(error);
        },
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        waiter.reject(new AppError("cancelled", "Repository request was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next && !this.disposed) next.resolve();
    else this.active--;
  }
}
