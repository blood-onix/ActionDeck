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
