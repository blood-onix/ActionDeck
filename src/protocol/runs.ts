import { z } from "zod";

export const runInspectPayload = z.object({
  runId: z.number().int().positive(),
  attempt: z.number().int().positive().optional(),
}).strict();

export const runLogsPayload = z.object({
  runId: z.number().int().positive(),
  attempt: z.number().int().positive(),
  jobId: z.number().int().positive(),
  stepNumber: z.number().int().positive().optional(),
}).strict();

export const runActionPayload = z.object({
  action: z.enum(["cancel", "rerun_failed_jobs", "rerun_all"]),
  runId: z.number().int().positive(),
  attempt: z.number().int().positive(),
}).strict();

export const runInvestigatePayload = z.object({
  runId: z.number().int().positive(),
  attempt: z.number().int().positive(),
  jobId: z.number().int().positive(),
  stepNumber: z.number().int().positive().optional(),
  workflowId: z.number().int().positive(),
  ref: z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  presentation: z.enum(["panel", "editor"]).optional(),
}).strict();

const boundedLabel = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

export const runOpenChatPayload = z.object({
  runId: z.number().int().positive(),
  attempt: z.number().int().positive(),
  jobId: z.number().int().positive(),
  stepNumber: z.number().int().positive().optional(),
  workflowId: z.number().int().positive(),
  ref: boundedLabel,
  jobName: boundedLabel.optional(),
  stepName: boundedLabel.optional(),
  workflowPath: boundedLabel.optional(),
}).strict();

export const planExplainBlockedPayload = z.object({
  planId: z.string().min(1).max(128),
}).strict();
