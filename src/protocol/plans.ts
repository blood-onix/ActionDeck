import { z } from "zod";
import { MAX_WAIT_BEFORE_MINUTES } from "../domain/models/release-plan";

const ref = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const workflowPath = z.string().min(1).max(256).regex(/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i);
const inputValues = z.record(
  z.string().min(1).max(128),
  z.string().max(65_535),
).refine((values) => Object.keys(values).length <= 25);

export const planSavePayload = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  steps: z.array(z.object({
    id: z.string().min(1).max(128),
    workflowId: z.number().int().positive(),
    workflowPath,
    ref,
    inputs: inputValues,
    sensitiveInputKeys: z.array(z.string().min(1).max(128)).max(25),
    gate: z.enum(["on_success", "on_any_completion", "stop_on_non_success"]),
    parallelWithPrevious: z.boolean().optional(),
    waitBeforeMinutes: z.number().int().min(0).max(MAX_WAIT_BEFORE_MINUTES).optional(),
    confirmBefore: z.boolean().optional(),
    autoApprove: z.object({
      environments: z.array(z.string().min(1).max(255)).max(50).nullable(),
    }).strict().optional(),
  }).strict()).min(1).max(20),
  schedule: z.object({
    kind: z.enum(["relative", "absolute"]),
    runAtMs: z.number().finite().positive(),
    delayMs: z.number().finite().nonnegative().optional(),
    timeZone: z.string().min(1).max(64),
  }).strict().optional(),
}).strict();

export const planControlPayload = z.object({
  planId: z.string().min(1).max(128),
  runtimeInputs: z.record(z.string().min(1).max(128), inputValues).optional(),
}).strict();
