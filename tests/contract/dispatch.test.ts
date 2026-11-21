import { describe, expect, it } from "vitest";
import {
  dispatchAssociationPayload,
  dispatchSubmitPayload,
  dispatchValidatePayload,
  localPreviewPayload,
} from "../../src/protocol/dispatch";
import { requestSchema } from "../../src/protocol/envelopes";

describe("workflow dispatch contract", () => {
  it("accepts only a repository-relative workflow path for local preview", () => {
    expect(localPreviewPayload.safeParse({ workflowPath: ".github/workflows/release.yml" }).success).toBe(true);
    expect(localPreviewPayload.safeParse({ workflowPath: "../secrets.yml" }).success).toBe(false);
    expect(localPreviewPayload.safeParse({ workflowPath: "https://example.com/workflow.yml" }).success).toBe(false);
    expect(localPreviewPayload.safeParse({
      workflowPath: ".github/workflows/release.yml",
      source: "untrusted YAML",
    }).success).toBe(false);
  });

  it("bounds and validates the exact selected workflow, ref, and input values", () => {
    const request = {
      workflowId: 7,
      ref: "refs/heads/release",
      inputs: { version: "2.0", dry_run: "false" },
      reviewToken: "c35c7c97-5d81-4531-a867-16a99ce0717f",
    };
    expect(dispatchValidatePayload.safeParse({
      workflowId: request.workflowId,
      ref: request.ref,
      inputs: request.inputs,
    }).success).toBe(true);
    expect(dispatchSubmitPayload.safeParse(request).success).toBe(true);
    expect(dispatchSubmitPayload.safeParse({ ...request, ref: "main\u0000" }).success).toBe(false);
    expect(dispatchSubmitPayload.safeParse({ ...request, workflowId: 0 }).success).toBe(false);
    expect(dispatchSubmitPayload.safeParse({ ...request, force: true }).success).toBe(false);
  });

  it("routes strict dispatch operations through the versioned message envelope", () => {
    expect(requestSchema.safeParse({
      version: 1,
      type: "request",
      requestId: "preview",
      operation: "workflow.localPreview",
      payload: { workflowPath: ".github/workflows/release.yml" },
    }).success).toBe(true);
    expect(requestSchema.safeParse({
      version: 1,
      type: "request",
      requestId: "dispatch",
      operation: "dispatch.submit",
      payload: { workflowId: 7, ref: "main", inputs: {}, url: "https://example.com" },
    }).success).toBe(false);
    const association = {
      workflowId: 7,
      ref: "main",
      submittedAt: 1_800_000_000_000,
      acceptedAt: 1_800_000_001_000,
    };
    expect(dispatchAssociationPayload.safeParse(association).success).toBe(true);
    expect(requestSchema.safeParse({
      version: 1,
      type: "request",
      requestId: "association",
      operation: "dispatch.association",
      payload: association,
    }).success).toBe(true);
    expect(dispatchAssociationPayload.safeParse({ ...association, acceptedAt: -1 }).success).toBe(false);
  });
});
