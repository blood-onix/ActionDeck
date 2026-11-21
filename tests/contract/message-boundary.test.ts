import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  eventSchema,
  hostEvent,
  responseSchema,
  successResponse,
  MAX_PROJECTION_BYTES,
  validateRequest,
} from "../../src/protocol/envelopes";

describe("host-webview request boundary", () => {
  it("accepts only versioned allowlisted requests with strict empty payloads", () => {
    expect(validateRequest({ version: 1, type: "request", requestId: "a", operation: "dashboard.load", payload: {} }).success).toBe(true);
    expect(validateRequest({ version: 1, type: "request", requestId: "a", operation: "dashboard.load", payload: { cached: true } }).success).toBe(true);
    expect(validateRequest({ version: 1, type: "request", requestId: "a", operation: "dashboard.load", payload: { cached: "yes" } }).success).toBe(false);
    expect(validateRequest({ version: 1, type: "request", requestId: "a", operation: "arbitrary", payload: {} }).success).toBe(false);
    expect(validateRequest({ version: 1, type: "request", requestId: "a", operation: "dashboard.load", payload: { url: "https://example.com" } }).success).toBe(false);
    expect(validateRequest({ version: 1, type: "request", requestId: "x".repeat(129), operation: "dashboard.load", payload: {} }).success).toBe(false);
  });

  it("validates bounded inspection identifiers and rejects extra log fields", () => {
    expect(validateRequest({
      version: 1,
      type: "request",
      requestId: "history",
      operation: "workflow.history.load",
      payload: { workflowId: 7, page: 5 },
    }).success).toBe(true);
    expect(validateRequest({
      version: 1,
      type: "request",
      requestId: "history",
      operation: "workflow.history.load",
      payload: { workflowId: 7, page: 6 },
    }).success).toBe(false);
    expect(validateRequest({
      version: 1,
      type: "request",
      requestId: "inspect",
      operation: "run.inspect",
      payload: { runId: 25, attempt: 2 },
    }).success).toBe(true);
    expect(validateRequest({
      version: 1,
      type: "request",
      requestId: "log",
      operation: "run.logs.load",
      payload: { runId: 25, attempt: 2, jobId: 7, stepNumber: 1 },
    }).success).toBe(true);
    expect(validateRequest({
      version: 1,
      type: "request",
      requestId: "log",
      operation: "run.logs.load",
      payload: { runId: 25, attempt: 2, jobId: 7, url: "https://evil.example" },
    }).success).toBe(false);
  });

  it("rejects payloads larger than the byte limit before schema validation", () => {
    const result = validateRequest({
      version: 1,
      type: "request",
      requestId: "a",
      operation: "dashboard.load",
      payload: { data: "x".repeat(MAX_MESSAGE_BYTES) },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("64 KiB");
  });

  it("validates correlated response and bounded event envelopes", () => {
    expect(responseSchema.safeParse({
      version: 1, type: "response", requestId: "a", ok: true, data: {},
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      version: 1, type: "response", requestId: "a", ok: false,
      error: { code: "rate_limited", message: "Wait", retryable: true },
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      version: 1, type: "response", requestId: "a", ok: false,
      error: { code: "unknown", message: "Wait", retryable: true },
    }).success).toBe(false);
    expect(eventSchema.safeParse({
      version: 1, type: "event", eventId: "e", event: "refresh", payload: {},
    }).success).toBe(true);
    expect(eventSchema.safeParse({
      version: 1, type: "event", eventId: "e".repeat(129), event: "refresh", payload: {},
    }).success).toBe(false);
  });

  it("strips credential fields and redacts sensitive assignments in projections", () => {
    const response = successResponse("safe", {
      accessToken: "host-only",
      profile: { api_key: "also-host-only", label: "Authorization: Bearer sample-secret" },
    });
    expect(JSON.stringify(response)).not.toContain("host-only");
    expect(JSON.stringify(response)).not.toContain("also-host-only");
    expect(JSON.stringify(response)).not.toContain("sample-secret");
    expect(response.data.profile).toEqual({ label: "Authorization: [REDACTED]" });
    expect(hostEvent("event", "refresh", { token: "hidden", message: "TOKEN=hidden" }).payload)
      .toEqual({ message: "TOKEN=[REDACTED]" });
    expect(() => successResponse("too-large", { text: "x".repeat(MAX_PROJECTION_BYTES) }))
      .toThrow("Projection exceeds the response byte limit");
  });

  it("delivers the one-time dispatch review UUID but still strips non-UUID review tokens", () => {
    const nonce = "c35c7c97-5d81-4531-a867-16a99ce0717f";
    const kept = successResponse("r", { validation: { valid: true }, reviewToken: nonce });
    expect(kept.ok && kept.data.reviewToken).toBe(nonce);
    const leaky = successResponse("r", { reviewToken: "ghp_notauuid", nested: { reviewToken: nonce, accessToken: nonce } });
    expect(leaky.ok && leaky.data).toEqual({ nested: { reviewToken: nonce } });
  });
});

describe("settings projection redaction", () => {
  it("keeps secret metadata lists but strips anything that could carry a value", () => {
    const secrets = [
      { name: "DEPLOY_KEY", updatedAt: "2026-01-01T00:00:00Z", scope: "repository" },
      { name: "API", updatedAt: "2026-01-02T00:00:00Z", scope: "environment", environmentName: "prod" },
    ];
    const kept = successResponse("r", { card: "variables_and_secrets", state: "loaded", variables: [], secrets });
    expect(kept.ok && kept.data.secrets).toEqual(secrets);

    const leaky = successResponse("r", { secrets: [{ name: "X", value: "hunter2" }], token: "abc", clientSecret: "s" });
    expect(leaky.ok && leaky.data).toEqual({});
  });
});
