export type AppErrorCode =
  | "invalid_input"
  | "not_found"
  | "inaccessible"
  | "authentication_required"
  | "auth_or_org_required"
  | "permission_restricted"
  | "rate_limited"
  | "stale"
  | "cancelled"
  | "network"
  | "service";

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}
