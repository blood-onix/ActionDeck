export type DataStateKind =
  | "not_loaded"
  | "loading"
  | "empty"
  | "stale"
  | "restricted"
  | "sso"
  | "expired"
  | "in_progress"
  | "uncertain";

export type DataState =
  | {
      readonly kind: "not_loaded";
      readonly title: string;
      readonly detail?: string;
      readonly actionLabel: string;
    }
  | {
      readonly kind: "loading";
      readonly label: string;
      readonly bars?: readonly number[];
    }
  | {
      readonly kind: "empty";
      readonly title: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "stale";
      readonly title: string;
      readonly lastUpdated?: string;
      readonly retryAt?: string;
      readonly detail: string;
      readonly hasRetainedData: boolean;
    }
  | {
      readonly kind: "restricted";
      readonly title: string;
      readonly missingScopeOrReason: string;
    }
  | {
      readonly kind: "sso";
      readonly title: string;
      readonly detail: string;
      readonly actionLabel: string;
    }
  | {
      readonly kind: "expired";
      readonly title: string;
      readonly detail: string;
      readonly externalUrl?: string;
    }
  | {
      readonly kind: "in_progress";
      readonly title: string;
      readonly detail: string;
    }
  | {
      readonly kind: "uncertain";
      readonly title: string;
      readonly detail: string;
      readonly actionLabel: string;
    };

export function mapErrorToDataState(
  code: string | undefined,
  message: string,
  options?: { lastUpdated?: string; retryAt?: string; hasRetainedData?: boolean },
): DataState {
  if (code === "auth_or_org_required") {
    return {
      kind: "sso",
      title: "SSO authorization required",
      detail: message,
      actionLabel: "Authorize SSO",
    };
  }
  if (
    code === "permission_restricted" ||
    code === "inaccessible" ||
    code === "authentication_required"
  ) {
    return {
      kind: "restricted",
      title: "Permission restricted",
      missingScopeOrReason: message,
    };
  }
  if (code === "rate_limited" || code === "stale" || code === "temporarily_unavailable") {
    return {
      kind: "stale",
      title: code === "rate_limited" ? "Rate limited" : "Showing stale data",
      ...(options?.lastUpdated ? { lastUpdated: options.lastUpdated } : {}),
      ...(options?.retryAt ? { retryAt: options.retryAt } : {}),
      detail: message,
      hasRetainedData: Boolean(options?.hasRetainedData),
    };
  }
  if (code === "outcome_uncertain") {
    return {
      kind: "uncertain",
      title: "Outcome uncertain",
      detail: message,
      actionLabel: "Find run",
    };
  }
  return {
    kind: "stale",
    title: "Showing stale data",
    ...(options?.lastUpdated ? { lastUpdated: options.lastUpdated } : {}),
    detail: message,
    hasRetainedData: Boolean(options?.hasRetainedData),
  };
}

export function mapLogAvailabilityToDataState(
  availability: string,
  message?: string,
  externalUrl?: string,
): DataState | null {
  if (availability === "expired") {
    return {
      kind: "expired",
      title: "Logs expired",
      detail: message ?? "GitHub retention period has elapsed for this run.",
      ...(externalUrl ? { externalUrl } : {}),
    };
  }
  if (availability === "in_progress") {
    return {
      kind: "in_progress",
      title: "Logs in progress",
      detail: message ?? "Logs are still being produced; refresh when the job completes.",
    };
  }
  if (availability === "permission_restricted") {
    return {
      kind: "restricted",
      title: "Permission restricted",
      missingScopeOrReason: message ?? "Actions read access is required to view logs.",
    };
  }
  if (availability === "auth_or_org_required") {
    return {
      kind: "sso",
      title: "SSO authorization required",
      detail: message ?? "Authorize organization SSO to view logs.",
      actionLabel: "Authorize SSO",
    };
  }
  if (availability === "rate_limited" || availability === "temporarily_unavailable") {
    return {
      kind: "stale",
      title: availability === "rate_limited" ? "Rate limited" : "Showing stale data",
      detail: message ?? "Log loading was interrupted.",
      hasRetainedData: false,
    };
  }
  return null;
}
