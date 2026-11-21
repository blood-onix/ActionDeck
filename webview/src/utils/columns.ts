import {
  configurableColumnIds,
  type ColumnLayout,
  type ConfigurableColumnId,
  type ResizableColumnId,
} from "../../../src/protocol/preferences";

export type { ColumnLayout, ConfigurableColumnId, ResizableColumnId };
export { configurableColumnIds };

export const COLUMN_LABELS: Record<ConfigurableColumnId, string> = {
  path: "Path",
  availability: "Availability",
  lastRun: "Last run",
  branch: "Branch",
  actor: "Actor",
  duration: "Duration",
  health: "Recent pass/fail",
  notifications: "Notifications",
};

export const DEFAULT_COLUMN_LAYOUT: ColumnLayout = {
  order: [...configurableColumnIds],
  // Availability is shown as a pill next to the workflow name unless the user opts into the column.
  hidden: ["availability"],
  widths: {},
};

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 1_200;

/** Repairs a stored layout so every known column appears exactly once, in a stable order. */
export function normalizeColumnLayout(layout: ColumnLayout | undefined): ColumnLayout {
  if (!layout) return DEFAULT_COLUMN_LAYOUT;
  const known = new Set<string>(configurableColumnIds);
  const order = layout.order.filter((id, index) => known.has(id) && layout.order.indexOf(id) === index);
  for (const id of configurableColumnIds) {
    if (!order.includes(id)) {
      // New columns keep their default position relative to the columns before them.
      const before = configurableColumnIds.slice(0, configurableColumnIds.indexOf(id));
      const anchor = Math.max(-1, ...before.map((candidate) => order.indexOf(candidate))) + 1;
      order.splice(anchor, 0, id);
    }
  }
  return {
    order,
    hidden: layout.hidden.filter((id) => known.has(id)),
    widths: Object.fromEntries(
      Object.entries(layout.widths).filter(
        ([id, width]) => (known.has(id) || id === "name") && typeof width === "number",
      ),
    ) as ColumnLayout["widths"],
  };
}

export function moveColumn(layout: ColumnLayout, id: ConfigurableColumnId, targetIndex: number): ColumnLayout {
  const order = layout.order.filter((candidate) => candidate !== id);
  const index = Math.max(0, Math.min(order.length, targetIndex));
  order.splice(index, 0, id);
  return { ...layout, order };
}

export function setColumnHidden(layout: ColumnLayout, id: ConfigurableColumnId, hidden: boolean): ColumnLayout {
  const rest = layout.hidden.filter((candidate) => candidate !== id);
  return { ...layout, hidden: hidden ? [...rest, id] : rest };
}

export function setColumnWidth(layout: ColumnLayout, id: ResizableColumnId, width: number | undefined): ColumnLayout {
  const widths = { ...layout.widths };
  if (width === undefined) delete widths[id];
  else widths[id] = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
  return { ...layout, widths };
}

/** Columns dropped automatically when the panel is narrow, on top of what the user hid. */
export function autoHiddenColumns(panelWidth: number): ReadonlySet<ConfigurableColumnId> {
  const hidden = new Set<ConfigurableColumnId>();
  if (panelWidth < 900) hidden.add("path");
  if (panelWidth < 700) hidden.add("actor");
  if (panelWidth < 600) hidden.add("branch");
  if (panelWidth < 500) hidden.add("duration");
  return hidden;
}
