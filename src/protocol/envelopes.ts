import { z } from "zod";
import { redactSensitiveText } from "../domain/services/redaction";
import {
  planExplainBlockedPayload,
  runActionPayload,
  runInspectPayload,
  runInvestigatePayload,
  runOpenChatPayload,
  runLogsPayload,
} from "./runs";
import {
  dispatchAssociationPayload,
  dispatchSubmitPayload,
  dispatchValidatePayload,
  localPreviewPayload,
  repositoryBranchesPayload,
  workflowProposeFixPayload,
} from "./dispatch";
import { batchSubmitPayload, batchValidatePayload } from "./batch";
import { planControlPayload, planSavePayload } from "./plans";
import {
  approvalRuleSavePayload,
  approvalRuleSetEnabledPayload,
  deploymentListPayload,
  deploymentReviewPayload,
  subscriptionUpdatePayload,
} from "./approvals";
import { settingsCachedCardsPayload, settingsLoadCardPayload } from "./settings";
import { columnLayoutSavePayload, workflowSetGroupPayload } from "./preferences";
import { viewOpenInTabPayload } from "./dashboard";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_PROJECTION_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const requestBase = {
  version: z.literal(1),
  type: z.literal("request"),
  requestId: z.string().min(1).max(128),
};

export const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    ...requestBase,
    operation: z.literal("repository.select"),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("external.open"),
    payload: z.object({ url: z.string().min(1).max(2_048) }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("dashboard.load"),
    payload: z.object({ cached: z.boolean().optional() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("workflow.history.load"),
    payload: z.object({
      workflowId: z.number().int().positive(),
      page: z.number().int().min(1).max(5).optional(),
      cached: z.boolean().optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("run.inspect"),
    payload: runInspectPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("run.logs.load"),
    payload: runLogsPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("run.action"),
    payload: runActionPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("run.investigate"),
    payload: runInvestigatePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("run.openChat"),
    payload: runOpenChatPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("plan.explainBlocked"),
    payload: planExplainBlockedPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("workflow.localPreview"),
    payload: localPreviewPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("workflow.openFile"),
    payload: localPreviewPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("workflow.proposeFix"),
    payload: workflowProposeFixPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("repository.branches"),
    payload: repositoryBranchesPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("dispatch.validate"),
    payload: dispatchValidatePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("dispatch.submit"),
    payload: dispatchSubmitPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("dispatch.association"),
    payload: dispatchAssociationPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("batch.validate"),
    payload: batchValidatePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("batch.submit"),
    payload: batchSubmitPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("plan.save"),
    payload: planSavePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("plan.start"),
    payload: planControlPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("plan.pause"),
    payload: planControlPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("plan.resume"),
    payload: planControlPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("plan.stop"),
    payload: planControlPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("subscription.update"),
    payload: subscriptionUpdatePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("deployment.list"),
    payload: deploymentListPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("deployment.review"),
    payload: deploymentReviewPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("approvalRule.save"),
    payload: approvalRuleSavePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("approvalRule.setEnabled"),
    payload: approvalRuleSetEnabledPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("settings.loadCard"),
    payload: settingsLoadCardPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("settings.cachedCards"),
    payload: settingsCachedCardsPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("workflow.setGroup"),
    payload: workflowSetGroupPayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("dashboard.saveColumns"),
    payload: columnLayoutSavePayload,
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal("view.openInTab"),
    payload: viewOpenInTabPayload,
  }).strict(),
]);

export const cancelRequestSchema = z.object({
  version: z.literal(1),
  type: z.literal("cancel"),
  requestId: z.string().min(1).max(128),
}).strict();

export type HostRequest = z.infer<typeof requestSchema>;
export type HostOperation = HostRequest["operation"];

const errorSchema = z.object({
  code: z.enum([
    "invalid_input",
    "not_found",
    "inaccessible",
    "authentication_required",
    "auth_or_org_required",
    "permission_restricted",
    "rate_limited",
    "stale",
    "cancelled",
    "network",
    "service",
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const responseSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(1),
    type: z.literal("response"),
    requestId: z.string().min(1).max(128),
    ok: z.literal(true),
    data: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("response"),
    requestId: z.string().min(1).max(128),
    ok: z.literal(false),
    error: errorSchema,
  }).strict(),
]);

export const eventSchema = z.object({
  version: z.literal(1),
  type: z.literal("event"),
  eventId: z.string().min(1).max(128),
  event: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type HostResponse = z.infer<typeof responseSchema>;
export type HostEvent = z.infer<typeof eventSchema>;
export type HostCancelRequest = z.infer<typeof cancelRequestSchema>;

export function sanitizeProjection(value: unknown): Record<string, unknown> {
  const ancestors = new WeakSet<object>();
  const sanitize = (current: unknown, depth: number): unknown => {
    if (depth > 32) throw new TypeError("Projection exceeds the maximum nesting depth.");
    if (typeof current === "string") return redactSensitiveText(current);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Projection contains a non-finite number.");
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > 10_000) throw new TypeError("Projection contains too many array items.");
      if (ancestors.has(current)) throw new TypeError("Projection contains a circular reference.");
      ancestors.add(current);
      const result = current.map((item) => sanitize(item, depth + 1));
      ancestors.delete(current);
      return result;
    }
    if (typeof current !== "object" || current === undefined) {
      throw new TypeError("Projection contains a non-serializable value.");
    }
    if (ancestors.has(current)) throw new TypeError("Projection contains a circular reference.");
    ancestors.add(current);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(current);
    if (entries.length > 10_000) throw new TypeError("Projection contains too many object properties.");
    for (const [key, item] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (
        /(?:token|password|secret|authorization|(?:^|[_-])key$)/i.test(key) &&
        !isSecretMetadataList(key, item) &&
        !isReviewNonce(key, item)
      ) continue;
      result[key] = sanitize(item, depth + 1);
    }
    ancestors.delete(current);
    return result;
  };

  const sanitized = sanitize(value, 0);
  if (!isRecord(sanitized)) {
    throw new TypeError("Protocol projections must be objects.");
  }
  const serialized = JSON.stringify(sanitized);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PROJECTION_BYTES) {
    throw new TypeError("Projection exceeds the response byte limit.");
  }
  return sanitized;
}

// GitHub never returns secret values, only names and timestamps. A `secrets` list whose entries
// carry nothing but those metadata fields is safe to project; anything else stays redacted.
const SECRET_METADATA_FIELDS = new Set(["name", "updatedAt", "scope", "environmentName"]);

function isSecretMetadataList(key: string, value: unknown): boolean {
  return key === "secrets" &&
    Array.isArray(value) &&
    value.every((entry) =>
      isRecord(entry) &&
      Object.entries(entry).every(([field, fieldValue]) =>
        SECRET_METADATA_FIELDS.has(field) && typeof fieldValue === "string"));
}

// Dispatch review tokens are host-minted one-time UUID nonces, not credentials; the webview must echo them back.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isReviewNonce(key: string, value: unknown): boolean {
  return key === "reviewToken" && typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRequest(raw: unknown) {
  try {
    const text = JSON.stringify(raw);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      return { success: false as const, error: "Request exceeds the 64 KiB limit" };
    }
  } catch {
    return { success: false as const, error: "Request is not JSON serializable" };
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return parsed;
  return parsed;
}

export function successResponse(requestId: string, data: unknown) {
  return responseSchema.parse({
    version: 1,
    type: "response",
    requestId,
    ok: true,
    data: sanitizeProjection(data),
  });
}

export function errorResponse(
  requestId: string,
  error: z.input<typeof errorSchema>,
) {
  return responseSchema.parse({
    version: 1,
    type: "response",
    requestId,
    ok: false,
    error: {
      ...error,
      message: redactSensitiveText(error.message),
      ...(error.details ? { details: sanitizeProjection(error.details) } : {}),
    },
  });
}

export function hostEvent(eventId: string, event: string, payload: unknown): HostEvent {
  return eventSchema.parse({
    version: 1,
    type: "event",
    eventId,
    event,
    payload: sanitizeProjection(payload),
  });
}
