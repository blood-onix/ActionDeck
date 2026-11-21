import type {
  EnvironmentSummary,
  RunnerSummary,
  SecretMetadata,
  SettingsCardKind,
  SettingsCardResult,
  SettingsCardState,
  SettingsRestriction,
  VariableSummary,
} from "../../domain/models/settings";
import { AppError } from "../../domain/models/errors";
import { classifyGitHubError } from "../../github/client/classify-error";

export interface VariablesAndSecrets {
  variables: VariableSummary[];
  secrets: SecretMetadata[];
  restrictions?: SettingsRestriction[];
  truncated?: boolean;
}

export interface SettingsRepositoryPort {
  loadEnvironments(signal?: AbortSignal): Promise<EnvironmentSummary[]>;
  loadVariablesAndSecrets(signal?: AbortSignal): Promise<VariablesAndSecrets>;
  loadRunners(signal?: AbortSignal): Promise<RunnerSummary[]>;
}

export async function loadSettingsCard(
  repository: SettingsRepositoryPort,
  card: SettingsCardKind,
  signal?: AbortSignal,
): Promise<SettingsCardResult> {
  const refreshedAt = new Date().toISOString();
  try {
    if (card === "environments") {
      const environments = await repository.loadEnvironments(signal);
      if (environments.length === 0) return { card, state: "empty", refreshedAt };
      return { card, state: "loaded", refreshedAt, environments };
    }
    if (card === "variables_and_secrets") {
      const { variables, secrets, restrictions, truncated } = await repository.loadVariablesAndSecrets(signal);
      if (variables.length === 0 && secrets.length === 0 && !restrictions?.length) {
        return { card, state: "empty", refreshedAt };
      }
      return {
        card,
        state: "loaded",
        refreshedAt,
        variables,
        secrets,
        ...(restrictions?.length ? { restrictions } : {}),
        ...(truncated ? { truncated } : {}),
      };
    }
    const runners = await repository.loadRunners(signal);
    if (runners.length === 0) return { card, state: "empty", refreshedAt };
    return {
      card,
      state: "loaded",
      refreshedAt,
      pollingNote: "Last-refreshed polling-based runner presence (not a live stream).",
      runners,
    };
  } catch (error) {
    const appError = error instanceof AppError ? error : classifyGitHubError(error);
    return {
      card,
      state: mapErrorToCardState(appError),
      refreshedAt,
      reason: appError.message,
    };
  }
}

export function mapErrorToCardState(error: AppError): Exclude<SettingsCardState, "loaded" | "empty"> {
  if (error.code === "permission_restricted" || error.code === "inaccessible") {
    return "permission_restricted";
  }
  if (error.code === "authentication_required" || error.code === "auth_or_org_required") {
    return "auth_or_org_required";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  return "temporarily_unavailable";
}
