import { z } from "zod";
import { workflowAvailability } from "../domain/models/workflow";
import { columnLayoutSchema } from "./preferences";
import { MAX_WAIT_BEFORE_MINUTES } from "../domain/models/release-plan";

export const dashboardLoadPayload = z.object({}).strict();

const dashboardWorkflowSchema = z.object({
  id: z.string().min(1).max(256),
  workflowId: z.number().int().positive().optional(),
  latestRunId: z.number().int().positive().optional(),
  state: z.enum(["active", "disabled"]),
  historyHydration: z.enum(["not_loaded", "partial", "loaded", "restricted"]),
  name: z.string().max(512),
  path: z.string().max(1_024),
  folder: z.string().max(512),
  availability: z.enum(workflowAvailability),
  status: z.string().max(256),
  title: z.string().max(1_024),
  branch: z.string().max(512),
  actor: z.string().max(256),
  isMyRun: z.boolean(),
  duration: z.string().max(128),
  metrics: z.object({
    passes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    sampleSize: z.number().int().nonnegative().max(100),
    scope: z.string().max(128),
    passRate: z.number().min(0).max(1).nullable(),
    averageDurationMs: z.number().nonnegative().nullable(),
  }).strict(),
  diagnostic: z.string().max(4_096).optional(),
  latestConclusion: z.string().max(64).nullable().optional(),
  latestRunAt: z.string().max(64).optional(),
  latestTriggeringActor: z.string().max(256).optional(),
  notificationMode: z.enum(["my_runs_only", "all_runs", "muted"]).optional(),
}).strict();

const planStepSchema = z.object({
  id: z.string().min(1).max(128),
  workflowId: z.number().int().positive(),
  workflowPath: z.string().max(1_024),
  ref: z.string().max(512),
  inputs: z.record(z.string(), z.string().max(8_192)),
  sensitiveInputKeys: z.array(z.string().max(256)).max(100),
  reEntryRequiredKeys: z.array(z.string().max(256)).max(100).optional(),
  gate: z.enum(["on_success", "on_any_completion", "stop_on_non_success"]),
  parallelWithPrevious: z.boolean().optional(),
  waitBeforeMinutes: z.number().int().min(0).max(MAX_WAIT_BEFORE_MINUTES).optional(),
  confirmBefore: z.boolean().optional(),
  autoApprove: z.object({
    environments: z.array(z.string().max(255)).max(50).nullable(),
  }).strict().optional(),
  state: z.enum([
    "pending", "dispatching", "request_accepted", "running", "waiting_approval",
    "completed", "failed", "stopped", "outcome_uncertain",
  ]),
  runId: z.number().int().positive().optional(),
  conclusion: z.string().max(64).nullable().optional(),
  htmlUrl: z.string().max(2_048).optional(),
  submittedAt: z.number().optional(),
  acceptedAt: z.number().optional(),
  error: z.string().max(1_024).optional(),
}).strict();

export const dashboardPlanSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(256),
  repositoryId: z.string().max(1_024),
  state: z.enum([
    "draft", "scheduled", "running", "waiting_approval", "on_hold", "paused",
    "completed", "stopped", "blocked_uncertain", "missed_schedule",
  ]),
  steps: z.array(planStepSchema).max(100),
  currentStepIndex: z.number().int().nonnegative(),
  schedule: z.object({
    kind: z.enum(["relative", "absolute"]),
    runAtMs: z.number(),
    delayMs: z.number().optional(),
    timeZone: z.string().max(128),
  }).strict().optional(),
  hold: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("wait"), untilMs: z.number() }).strict(),
    z.object({ kind: z.literal("confirm") }).strict(),
  ]).optional(),
  blockedReason: z.string().max(2_048).optional(),
  updatedAt: z.number(),
}).strict();

const approvalRuleSchema = z.object({
  id: z.string().min(1).max(128),
  repositoryId: z.string().max(1_024),
  workflowId: z.number().int().positive(),
  environmentName: z.string().max(256),
  ref: z.string().max(512),
  authenticatedUserId: z.string().max(128),
  enabled: z.boolean(),
  createdAt: z.number(),
}).strict();

export const approvalAuditSchema = z.object({
  timestamp: z.number(),
  repositoryId: z.string().max(1_024).optional(),
  runId: z.number().int().positive(),
  workflowId: z.number().int().nonnegative(),
  environmentId: z.number().int().nonnegative(),
  environmentName: z.string().max(256),
  ruleId: z.string().max(128),
  status: z.enum(["succeeded", "failed", "outcome_uncertain", "skipped"]),
  error: z.string().max(1_000).optional(),
}).strict();

export const dashboardDataSchema = z.object({
  repository: z.object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    authenticatedUserId: z.string().max(128),
  }).strict(),
  workflows: z.array(dashboardWorkflowSchema).max(10_000),
  warning: z.string().max(2_000).optional(),
  warningKind: z.enum(["stale", "sso"]).optional(),
  initialWorkflowPath: z.string().max(256).optional(),
  initialAction: z.enum(["companion", "latest-run", "pipeline"]).optional(),
  initialRunId: z.number().int().positive().optional(),
  initialView: z.enum(["action-center"]).optional(),
  plans: z.array(dashboardPlanSchema).max(200).optional(),
  approvalRules: z.array(approvalRuleSchema).max(200).optional(),
  approvalAudit: z.array(approvalAuditSchema).max(50).optional(),
  /** Custom group names set from the dashboard; listed so the Group picker can offer them even when empty. */
  customGroups: z.array(z.string().max(128)).max(1_000).optional(),
  columnLayout: columnLayoutSchema.optional(),
  /** Default auto-refresh interval for an open, active run, in seconds; 0 means off. */
  runRefreshSeconds: z.number().int().min(0).max(3_600).optional(),
  /** Set when the data is a cached snapshot; the view shows it and revalidates in the background. */
  cachedAt: z.number().int().nonnegative().optional(),
}).strict();

/** Workflow paths a dedicated tab may target: local workflow files and GitHub dynamic workflows. */
export const tabWorkflowPathPattern = /^(?:\.github\/workflows\/[^/]+\.(?:yml|yaml)|dynamic(?:\/(?!\.+(?:\/|$))[A-Za-z0-9._-]+)+)$/i;

export const viewOpenInTabPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pipeline"),
    workflowPath: z.string().min(1).max(256).regex(tabWorkflowPathPattern),
  }).strict(),
  z.object({
    kind: z.literal("run"),
    runId: z.number().int().positive(),
  }).strict(),
]);
