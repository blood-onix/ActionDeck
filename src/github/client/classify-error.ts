import { AppError } from "../../domain/models/errors";

export function classifyGitHubError(error: unknown): AppError {
  const record = isRecord(error) ? error : {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const headers = getHeaders(record.response);
  if (status === 410) return new AppError("stale", "The requested GitHub job log has expired.");
  if (status === 401) return new AppError("authentication_required", "Sign in to GitHub to load repository data.");
  if (status === 429 || (status === 403 && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"]))) {
    return new AppError("rate_limited", "GitHub is rate limiting requests. Try again later.", true);
  }
  if (status === 403 && headers["x-github-sso"]) {
    return new AppError("auth_or_org_required", "Authorize this GitHub session for the organization's SSO policy.");
  }
  if (status === 403) return new AppError("permission_restricted", "GitHub denied access to this resource.");
  if (status === 404) return new AppError("inaccessible", "The resource is missing or inaccessible.");
  if (status && status >= 500) return new AppError("service", "GitHub is temporarily unavailable.", true);
  if (error instanceof TypeError) return new AppError("network", "Could not connect to GitHub.", true);
  return new AppError("service", "GitHub request failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getHeaders(response: unknown): Record<string, string> {
  if (!isRecord(response)) return {};
  const headers = response.headers;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (!isRecord(headers)) return {};
  return Object.fromEntries(Object.entries(headers)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => [name.toLowerCase(), value]));
}
