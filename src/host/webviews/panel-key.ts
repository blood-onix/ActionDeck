/** Identifies the surface a dashboard tab shows; tabs with the same key are the same tab. */
export function dashboardPanelKey(
  repositoryId: string,
  target: { initialRunId?: number | undefined; initialView?: string | undefined; initialAction?: string | undefined; workflowPath?: string | undefined },
): string {
  const surface = target.initialRunId !== undefined ? `run:${target.initialRunId}`
    : target.initialView === "action-center" ? "action-center"
    : target.workflowPath ? `${target.initialAction ?? "companion"}:${target.workflowPath.toLowerCase()}`
    : "dashboard";
  return `${repositoryId}|${surface}`;
}
