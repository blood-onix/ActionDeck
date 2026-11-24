/** Auto-refresh choices for an active run, in seconds; 0 turns auto-refresh off. */
export const RUN_REFRESH_OPTIONS = [0, 5, 10, 15, 30, 45, 60] as const;
export type RunRefreshSeconds = (typeof RUN_REFRESH_OPTIONS)[number];
export const DEFAULT_RUN_REFRESH_SECONDS: RunRefreshSeconds = 30;
export const RUN_REFRESH_SETTING = "runRefreshInterval";

/** The configured value when it is one of the offered choices, otherwise the default. */
export function normalizeRunRefreshSeconds(value: unknown): RunRefreshSeconds {
  return (RUN_REFRESH_OPTIONS as readonly unknown[]).includes(value) ? value as RunRefreshSeconds : DEFAULT_RUN_REFRESH_SECONDS;
}

export type SettingsCardKind = "environments" | "variables_and_secrets" | "runners";

export type SettingsCardState =
  | "loaded"
  | "empty"
  | "permission_restricted"
  | "auth_or_org_required"
  | "rate_limited"
  | "temporarily_unavailable";

export interface EnvironmentSummary {
  readonly id: number;
  readonly name: string;
  readonly waitTimer?: number;
  readonly reviewerCount: number;
  readonly branchPolicy: string;
}

export interface VariableSummary {
  readonly name: string;
  readonly value: string;
  readonly scope: "repository" | "environment";
  readonly environmentName?: string;
}

export interface SecretMetadata {
  readonly name: string;
  readonly updatedAt: string;
  readonly scope: "repository" | "environment";
  readonly environmentName?: string;
}

export interface SettingsRestriction {
  readonly scope: "repository" | "environment";
  readonly resource: "variables" | "secrets" | "environments";
  readonly environmentName?: string;
  readonly state: Exclude<SettingsCardState, "loaded" | "empty">;
  readonly reason?: string;
}

export interface RunnerSummary {
  readonly id: number;
  readonly name: string;
  readonly os: string;
  readonly labels: readonly string[];
  readonly online: boolean;
  readonly busy: boolean;
}

export type SettingsCardResult =
  | {
    readonly card: "environments";
    readonly state: "loaded";
    readonly refreshedAt: string;
    readonly environments: readonly EnvironmentSummary[];
  }
  | {
    readonly card: "variables_and_secrets";
    readonly state: "loaded";
    readonly refreshedAt: string;
    readonly variables: readonly VariableSummary[];
    readonly secrets: readonly SecretMetadata[];
    readonly restrictions?: readonly SettingsRestriction[];
    readonly truncated?: boolean;
  }
  | {
    readonly card: "runners";
    readonly state: "loaded";
    readonly refreshedAt: string;
    readonly pollingNote: string;
    readonly runners: readonly RunnerSummary[];
  }
  | {
    readonly card: SettingsCardKind;
    readonly state: Exclude<SettingsCardState, "loaded">;
    readonly refreshedAt: string;
    readonly reason?: string;
  };
