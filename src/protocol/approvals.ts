import { z } from "zod";

export const subscriptionUpdatePayload = z.object({
  workflowId: z.number().int().positive(),
  mode: z.enum(["my_runs_only", "all_runs", "muted"]),
}).strict();

export const deploymentListPayload = z.object({
  runId: z.number().int().positive(),
}).strict();

export const deploymentReviewPayload = z.object({
  runId: z.number().int().positive(),
  environmentIds: z.array(z.number().int().positive()).min(1).max(20),
  state: z.enum(["approved", "rejected"]),
  comment: z.string().max(1_024).optional(),
}).strict();

export const approvalRuleSavePayload = z.object({
  id: z.string().min(1).max(128),
  workflowId: z.number().int().positive(),
  environmentName: z.string().min(1).max(255),
  ref: z.string().min(1).max(255),
  enabled: z.boolean().default(false),
}).strict();

export const approvalRuleSetEnabledPayload = z.object({
  ruleId: z.string().min(1).max(128),
  enabled: z.boolean(),
}).strict();
