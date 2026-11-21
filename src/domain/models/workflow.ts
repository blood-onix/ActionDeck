export const workflowAvailability = [
  "synced",
  "remote_only",
  "local_only",
  "disabled",
  "never_run",
  "run_info_not_loaded",
  "partial_stale",
  "access_restricted",
  "invalid_yaml",
] as const;

export type WorkflowAvailability = typeof workflowAvailability[number];
export type WorkflowHistoryHydration = "not_loaded" | "partial" | "loaded" | "restricted";

export interface WorkflowItem {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly state: "active" | "disabled";
  readonly availability: WorkflowAvailability;
  readonly historyHydration: WorkflowHistoryHydration;
  readonly folder: string;
  readonly diagnostic?: string;
  readonly latestRun?: import("./run").WorkflowRunRecord;
  readonly workflowId?: number;
  readonly status?: string;
  readonly title?: string;
  readonly branch?: string;
  readonly actor?: string;
  readonly isMyRun?: boolean;
  readonly duration?: string;
  readonly latestRunId?: number;
  readonly latestConclusion?: string | null;
  readonly latestRunAt?: string;
  readonly latestTriggeringActor?: string;
  readonly notificationMode?: import("./notifications").SubscriptionMode;
  readonly metrics: {
    readonly passes: number;
    readonly failures: number;
    readonly sampleSize: number;
    readonly scope: string;
    readonly passRate: number | null;
    readonly averageDurationMs: number | null;
  };
}

export interface LocalWorkflow {
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly dispatchable: boolean;
  /** Reusable workflow template (`on: workflow_call` only); hidden from pipeline lists. */
  readonly reusable?: boolean;
  readonly diagnostic?: string;
}

export interface RemoteWorkflow {
  readonly id: number;
  readonly path: string;
  readonly name: string;
  readonly state: string;
  readonly htmlUrl?: string;
}
