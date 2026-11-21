export type LogAvailability =
  | "not_loaded"
  | "loading"
  | "loaded"
  | "truncated"
  | "expired"
  | "unavailable"
  | "restricted";

export interface StepRecord {
  readonly number: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface JobRecord {
  readonly id: number;
  readonly runId: number;
  readonly attempt: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runnerName?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly needs?: readonly string[];
  readonly steps: readonly StepRecord[];
  readonly logAvailability: LogAvailability;
}

export interface LogExcerpt {
  readonly jobId: number;
  readonly attempt: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly retrievedAt: string;
  readonly availability: Exclude<LogAvailability, "not_loaded" | "loading">;
  readonly stepNumber?: number;
  readonly stepBoundary?: "identified" | "unidentified";
  readonly message?: string;
}

export interface RunInspection {
  readonly runId: number;
  readonly attempt: number;
  readonly attemptCount: number;
  readonly hydration: "jobs_loaded";
  readonly workflowId?: number;
  readonly workflowPath?: string;
  readonly ref?: string;
  readonly dependencyResolution: "resolved" | "unresolved" | "unavailable";
  readonly title: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  readonly jobs: readonly JobRecord[];
}
