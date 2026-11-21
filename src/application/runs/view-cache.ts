import type { WorkflowRunRecord } from "../../domain/models/run";
import type { LogExcerpt, RunInspection } from "../../domain/models/job";
import type { BranchInventory } from "../../domain/models/dispatch";
import type { SettingsCardKind, SettingsCardResult } from "../../domain/models/settings";

/** Branch lists change rarely; serve them from cache for this long before refetching. */
export const BRANCH_CACHE_TTL_MS = 5 * 60_000;

/** GitHub serves at most 100 runs per history page and ActionDeck reads at most 5 pages. */
export const HISTORY_PAGE_SIZE = 100;
export const MAX_HISTORY_PAGES = 5;

export interface CachedSnapshot<T> {
  readonly value: T;
  readonly cachedAt: number;
  readonly userId: string | undefined;
}

export interface HistoryPageResponse {
  readonly runs: readonly WorkflowRunRecord[];
  readonly totalCount: number;
}

export interface MergedHistory {
  readonly runs: readonly WorkflowRunRecord[];
  readonly page: number;
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly cachedAt: number;
}

interface HistoryEntry {
  readonly pages: Map<number, readonly WorkflowRunRecord[]>;
  totalCount: number;
  cachedAt: number;
}

interface LatestAttempt {
  readonly attempt: number;
}

const MAX_INSPECTIONS = 300;
const MAX_LOGS = 40;

/**
 * Host-wide, in-memory read cache shared by every ActionDeck tab of a repository.
 *
 * Views render from it immediately and revalidate in the background. Only data that cannot change
 * is served without revalidation: job details and logs of completed run attempts.
 * Everything is keyed by repository and cleared when the GitHub identity for that repository changes.
 */
export class RepositoryViewCache {
  private readonly dashboards = new Map<string, CachedSnapshot<unknown>>();
  private readonly histories = new Map<string, Map<number, HistoryEntry>>();
  private readonly inspections = new Map<string, RunInspection>();
  private readonly latestAttempts = new Map<string, LatestAttempt>();
  private readonly logs = new Map<string, LogExcerpt>();
  private readonly branches = new Map<string, CachedSnapshot<BranchInventory>>();
  private readonly settings = new Map<string, Map<SettingsCardKind, CachedSnapshot<SettingsCardResult>>>();

  constructor(private readonly now: () => number = Date.now) {}

  getDashboard<T>(repositoryId: string, userId: string | undefined): CachedSnapshot<T> | undefined {
    const snapshot = this.dashboards.get(repositoryId);
    if (!snapshot || snapshot.userId !== userId) return undefined;
    return snapshot as CachedSnapshot<T>;
  }

  setDashboard<T>(repositoryId: string, userId: string | undefined, value: T, runs: readonly WorkflowRunRecord[] = []): void {
    this.dashboards.set(repositoryId, { value, cachedAt: this.now(), userId });
    this.noteRuns(repositoryId, runs);
  }

  /** Cached history pages for a workflow, merged newest first, or undefined if nothing is cached. */
  getHistory(repositoryId: string, workflowId: number): MergedHistory | undefined {
    const entry = this.histories.get(repositoryId)?.get(workflowId);
    return entry ? merged(entry) : undefined;
  }

  /** Whether `page` can be requested: page 1 always, later pages only after the previous one is cached. */
  canLoadHistoryPage(repositoryId: string, workflowId: number, page: number): boolean {
    if (page === 1) return true;
    return Boolean(this.histories.get(repositoryId)?.get(workflowId)?.pages.has(page - 1));
  }

  /**
   * Stores a freshly fetched page and returns the merged history. Refreshing page 1 keeps the older
   * pages already cached, so only the newest runs are refetched; duplicates are dropped by run id.
   */
  putHistoryPage(repositoryId: string, workflowId: number, page: number, response: HistoryPageResponse): MergedHistory {
    const byWorkflow = this.histories.get(repositoryId) ?? new Map<number, HistoryEntry>();
    const entry = byWorkflow.get(workflowId) ?? { pages: new Map(), totalCount: 0, cachedAt: 0 };
    entry.pages.set(page, response.runs);
    entry.totalCount = response.totalCount;
    entry.cachedAt = this.now();
    byWorkflow.set(workflowId, entry);
    this.histories.set(repositoryId, byWorkflow);
    this.noteRuns(repositoryId, response.runs);
    return merged(entry);
  }

  /**
   * A cached inspection for a completed attempt. Without an explicit attempt it resolves the latest
   * attempt last seen for the run; that mapping is dropped as soon as the run is seen re-running.
   */
  getInspection(repositoryId: string, runId: number, attempt?: number): RunInspection | undefined {
    const resolved = attempt ?? this.latestAttempts.get(runKey(repositoryId, runId))?.attempt;
    if (resolved === undefined) return undefined;
    return touch(this.inspections, attemptKey(repositoryId, runId, resolved));
  }

  putInspection(repositoryId: string, inspection: RunInspection, requestedAttempt?: number): void {
    if (inspection.status !== "completed") return;
    put(this.inspections, attemptKey(repositoryId, inspection.runId, inspection.attempt), inspection, MAX_INSPECTIONS);
    if (requestedAttempt === undefined || inspection.attempt === inspection.attemptCount) {
      this.latestAttempts.set(runKey(repositoryId, inspection.runId), { attempt: inspection.attemptCount });
    }
  }

  getLog(repositoryId: string, runId: number, attempt: number, jobId: number, stepNumber?: number): LogExcerpt | undefined {
    return touch(this.logs, logKey(repositoryId, runId, attempt, jobId, stepNumber));
  }

  /** Caches a log only once the job has finished and the log was actually retrieved. */
  putLog(
    repositoryId: string,
    runId: number,
    jobCompleted: boolean,
    excerpt: LogExcerpt,
    stepNumber?: number,
  ): void {
    if (!jobCompleted || excerpt.availability !== "loaded") return;
    put(this.logs, logKey(repositoryId, runId, excerpt.attempt, excerpt.jobId, stepNumber), excerpt, MAX_LOGS);
  }

  /** Forgets the latest-attempt shortcut for a run, e.g. after it was re-run or cancelled from ActionDeck. */
  invalidateRun(repositoryId: string, runId: number): void {
    this.latestAttempts.delete(runKey(repositoryId, runId));
  }

  /** Drops dashboard and history snapshots (kept for logs and finished attempts, which never change). */
  invalidateViews(repositoryId: string): void {
    this.dashboards.delete(repositoryId);
    this.histories.delete(repositoryId);
  }

  /** Cached branches for this identity while they are younger than the TTL. */
  getBranches(repositoryId: string, userId: string | undefined): CachedSnapshot<BranchInventory> | undefined {
    const snapshot = this.branches.get(repositoryId);
    if (!snapshot || snapshot.userId !== userId || this.now() - snapshot.cachedAt >= BRANCH_CACHE_TTL_MS) return undefined;
    return snapshot;
  }

  setBranches(repositoryId: string, userId: string | undefined, value: BranchInventory): CachedSnapshot<BranchInventory> {
    const snapshot = { value, cachedAt: this.now(), userId };
    this.branches.set(repositoryId, snapshot);
    return snapshot;
  }

  /**
   * Settings cards cached for this identity. They are costly to load (one call per environment) and
   * change rarely, so they are kept until refreshed explicitly or the identity changes.
   */
  getSettings(repositoryId: string, userId: string | undefined): Partial<Record<SettingsCardKind, SettingsCardResult>> {
    const cards: Partial<Record<SettingsCardKind, SettingsCardResult>> = {};
    for (const [card, snapshot] of this.settings.get(repositoryId) ?? []) {
      if (snapshot.userId === userId) cards[card] = snapshot.value;
    }
    return cards;
  }

  /** Keeps loaded, empty and permission results; transient failures never replace a good snapshot. */
  setSettingsCard(repositoryId: string, userId: string | undefined, result: SettingsCardResult): void {
    if (result.state === "rate_limited" || result.state === "temporarily_unavailable") return;
    const byCard = this.settings.get(repositoryId) ?? new Map<SettingsCardKind, CachedSnapshot<SettingsCardResult>>();
    byCard.set(result.card, { value: result, cachedAt: this.now(), userId });
    this.settings.set(repositoryId, byCard);
  }

  clear(repositoryId: string): void {
    this.invalidateViews(repositoryId);
    this.branches.delete(repositoryId);
    this.settings.delete(repositoryId);
    const prefix = `${repositoryId}\u0000`;
    for (const map of [this.inspections, this.latestAttempts, this.logs] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    }
  }

  clearAll(): void {
    this.dashboards.clear();
    this.branches.clear();
    this.settings.clear();
    this.histories.clear();
    this.inspections.clear();
    this.latestAttempts.clear();
    this.logs.clear();
  }

  private noteRuns(repositoryId: string, runs: readonly WorkflowRunRecord[]): void {
    for (const run of runs) {
      const key = runKey(repositoryId, run.id);
      const latest = this.latestAttempts.get(key);
      if (latest && (run.status !== "completed" || run.attemptCount !== latest.attempt)) this.latestAttempts.delete(key);
    }
  }
}

function merged(entry: HistoryEntry): MergedHistory {
  const pageNumbers = [...entry.pages.keys()].sort((left, right) => left - right);
  const seen = new Set<number>();
  const runs: WorkflowRunRecord[] = [];
  for (const page of pageNumbers) {
    for (const run of entry.pages.get(page) ?? []) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      runs.push(run);
    }
  }
  const page = pageNumbers.at(-1) ?? 1;
  return {
    runs,
    page,
    totalCount: entry.totalCount,
    hasMore: page < MAX_HISTORY_PAGES && page * HISTORY_PAGE_SIZE < entry.totalCount,
    cachedAt: entry.cachedAt,
  };
}

function runKey(repositoryId: string, runId: number): string {
  return `${repositoryId}\u0000${runId}`;
}

function attemptKey(repositoryId: string, runId: number, attempt: number): string {
  return `${repositoryId}\u0000${runId}:${attempt}`;
}

function logKey(repositoryId: string, runId: number, attempt: number, jobId: number, stepNumber?: number): string {
  return `${repositoryId}\u0000${runId}:${attempt}:${jobId}:${stepNumber ?? "all"}`;
}

function touch<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  map.delete(key);
  map.set(key, value);
  return value;
}

function put<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
