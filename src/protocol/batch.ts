import { z } from "zod";

const ref = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const workflowId = z.number().int().positive();
const inputValues = z.record(
  z.string().min(1).max(128),
  z.string().max(65_535),
).refine((values) => Object.keys(values).length <= 25);

export const batchValidatePayload = z.object({
  items: z.array(z.object({
    workflowId,
    ref: ref.optional(),
  }).strict()).min(1).max(25),
  sharedInputs: inputValues,
  defaultDecisions: z.record(
    z.string().min(1).max(128),
    z.enum(["use_shared_value", "retain_workflow_defaults"]),
  ),
  perWorkflowOverrides: z.record(z.string().regex(/^\d+$/), inputValues).optional(),
}).strict();

export const batchSubmitPayload = z.object({
  reviewToken: z.string().uuid(),
  items: z.array(z.object({
    workflowId,
    ref,
    inputs: inputValues,
  }).strict()).min(1).max(25),
}).strict();
