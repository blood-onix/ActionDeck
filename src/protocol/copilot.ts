import { z } from "zod";

const repositoryId = z.string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const workflowId = z.number().int().positive();
const runId = z.number().int().positive();
const attempt = z.number().int().positive();
const jobId = z.number().int().positive();
const ref = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const sha = z.string().regex(/^[a-f\d]{40,64}$/i);
const inputs = z.record(z.string().min(1).max(128), z.string().max(65_535))
  .refine((value) => Object.keys(value).length <= 25);

export const copilotEvidenceRequest = z.object({
  repositoryId,
  workflowId,
  runId,
  attempt,
  jobId,
  stepNumber: z.number().int().positive().optional(),
  ref,
}).strict();

export const copilotReadToolSchemas = {
  "actiondeck_list_workflows": z.object({
    repositoryId,
    filter: z.string().max(128).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  "actiondeck_inspect_run": z.object({
    repositoryId,
    runId,
    attempt,
  }).strict(),
  "actiondeck_get_log_excerpt": z.object({
    ...copilotEvidenceRequest.shape,
    maxLines: z.number().int().min(1).max(200).optional(),
  }).strict(),
  "actiondeck_get_workflow_revision": z.object({
    repositoryId,
    workflowId,
    runId: runId.optional(),
    attempt: attempt.optional(),
    ref: ref.optional(),
    sha: sha.optional(),
  }).strict().refine((value) =>
    Boolean(value.runId && value.attempt) || Boolean(value.ref || value.sha),
  ),
  "actiondeck_inspect_dispatch_inputs": z.object({
    repositoryId,
    workflowId,
    ref,
    inputs: inputs.optional(),
  }).strict(),
  "actiondeck_inspect_plan": z.object({
    repositoryId,
    planId: z.string().min(1).max(128),
  }).strict(),
  "actiondeck_inspect_pending_actions": z.object({
    repositoryId,
  }).strict(),
} as const;

export const copilotExecutionToolSchemas = {
  "actiondeck_dispatch_workflow": z.object({
    repositoryId,
    workflowId,
    ref,
    inputs: inputs.default({}),
  }).strict(),
  "actiondeck_run_action": z.object({
    repositoryId,
    action: z.enum(["cancel", "rerun_failed_jobs"]),
    runId,
    attempt,
  }).strict(),
  "actiondeck_review_deployment": z.object({
    repositoryId,
    runId,
    environmentIds: z.array(z.number().int().positive()).min(1).max(20),
    state: z.enum(["approved", "rejected"]),
    comment: z.string().max(1_024).optional(),
  }).strict(),
  "actiondeck_start_plan": z.object({
    repositoryId,
    planId: z.string().min(1).max(128),
  }).strict(),
} as const;

export type CopilotReadToolName = keyof typeof copilotReadToolSchemas;
export type CopilotExecutionToolName = keyof typeof copilotExecutionToolSchemas;
export type CopilotEvidenceRequest = z.infer<typeof copilotEvidenceRequest> & {
  readonly maxLines?: number;
};
