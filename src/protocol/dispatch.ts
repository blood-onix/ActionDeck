import { z } from "zod";

const ref = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const workflowId = z.number().int().positive();
const inputValues = z.record(
  z.string().min(1).max(128),
  z.string().max(65_535),
).refine((values) => Object.keys(values).length <= 25, "At most 25 workflow inputs are allowed.");

export const localPreviewPayload = z.object({
  workflowPath: z.string().min(1).max(256).regex(/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i),
}).strict();

export const repositoryBranchesPayload = z.object({
  refresh: z.boolean().optional(),
}).strict();

export const dispatchValidatePayload = z.object({
  workflowId,
  ref: ref.optional(),
  inputs: inputValues,
  review: z.boolean().optional(),
}).strict();

export const dispatchSubmitPayload = z.object({
  workflowId,
  ref,
  inputs: inputValues,
  reviewToken: z.string().uuid(),
  autoApproveEnvironments: z.literal(true).optional(),
}).strict();

export const dispatchAssociationPayload = z.object({
  workflowId,
  ref,
  submittedAt: z.number().finite().nonnegative(),
  acceptedAt: z.number().finite().nonnegative(),
}).strict();

export const workflowProposeFixPayload = z.object({
  workflowPath: z.string().min(1).max(256).regex(/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i),
  setAtPath: z.object({
    path: z.array(z.union([z.string().min(1).max(128), z.number().int().nonnegative()])).min(1).max(16),
    value: z.union([z.string().max(1_024), z.number(), z.boolean()]),
  }).strict().optional(),
}).strict();
