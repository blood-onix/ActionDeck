import { z } from "zod";

/** Table columns the user can show, hide, reorder and resize. Select, Workflow and Actions are always shown. */
export const configurableColumnIds = [
  "path",
  "availability",
  "lastRun",
  "branch",
  "actor",
  "duration",
  "health",
  "notifications",
] as const;
export type ConfigurableColumnId = (typeof configurableColumnIds)[number];
export type ResizableColumnId = ConfigurableColumnId | "name";

const columnId = z.enum(configurableColumnIds);
const resizableColumnId = z.enum([...configurableColumnIds, "name"]);

export const columnLayoutSchema = z.object({
  order: z.array(columnId).max(configurableColumnIds.length),
  hidden: z.array(columnId).max(configurableColumnIds.length),
  widths: z.partialRecord(resizableColumnId, z.number().int().min(48).max(1_200)),
}).strict();
export type ColumnLayout = z.infer<typeof columnLayoutSchema>;

export const columnLayoutSavePayload = z.object({ layout: columnLayoutSchema }).strict();

const groupName = z.string().trim().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

export const workflowSetGroupPayload = z.object({
  workflowPaths: z.array(z.string().min(1).max(1_024)).min(1).max(500),
  /** null removes the custom group so the @folder annotation or prefix rule applies again. */
  group: groupName.nullable(),
}).strict();

/** Custom groups set from the dashboard, keyed by normalized workflow path. */
export const workflowGroupsSchema = z.record(z.string().max(1_024), groupName);
