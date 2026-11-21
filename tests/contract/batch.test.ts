import { describe, expect, it } from "vitest";
import { batchSubmitPayload, batchValidatePayload } from "../../src/protocol/batch";

describe("Batch protocol contracts", () => {
  it("validates bounded batch validate and submit payloads", () => {
    expect(batchValidatePayload.safeParse({
      items: [
        { workflowId: 1, ref: "main" },
        { workflowId: 2, ref: "release" },
      ],
      sharedInputs: { env: "staging" },
      defaultDecisions: { env: "use_shared_value" },
    }).success).toBe(true);

    expect(batchValidatePayload.safeParse({
      items: [],
      sharedInputs: {},
      defaultDecisions: {},
    }).success).toBe(false);

    expect(batchSubmitPayload.safeParse({
      reviewToken: "11111111-1111-4111-8111-111111111111",
      items: [
        { workflowId: 1, ref: "main", inputs: { env: "staging" } },
      ],
    }).success).toBe(true);

    expect(batchSubmitPayload.safeParse({
      reviewToken: "not-a-uuid",
      items: [{ workflowId: 1, ref: "main", inputs: {} }],
    }).success).toBe(false);
  });
});
