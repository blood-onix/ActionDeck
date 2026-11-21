import { describe, expect, it } from "vitest";
import { classifyGitHubError } from "../../src/github/client/classify-error";

describe("GitHub response classification", () => {
  it("keeps rate limits, SSO restrictions, inaccessible resources and service failures distinct", () => {
    expect(classifyGitHubError({ status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } }).code).toBe("rate_limited");
    expect(classifyGitHubError({ status: 429, response: { headers: { "Retry-After": "30" } } }).code).toBe("rate_limited");
    const ssoError = classifyGitHubError({ status: 403, response: { headers: { "x-github-sso": "required; url=https://github.com/" } } });
    expect(ssoError.code).toBe("auth_or_org_required");
    expect(ssoError.message).toContain("SSO");
    expect(classifyGitHubError({ status: 403 }).code).toBe("permission_restricted");
    expect(classifyGitHubError({ status: 404 }).code).toBe("inaccessible");
    expect(classifyGitHubError({ status: 503 }).code).toBe("service");
    expect(classifyGitHubError({ status: 410 }).code).toBe("stale");
  });

  it("classifies transport failures without exposing response content", () => {
    const error = new TypeError("fetch failed");
    expect(classifyGitHubError(error).code).toBe("network");
    expect(classifyGitHubError(error).message).not.toContain("fetch failed");
    expect(classifyGitHubError(new Error("unexpected")).code).toBe("service");
  });
});
