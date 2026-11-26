/**
 * Identifies the surface a dashboard tab shows; tabs with the same key are the same tab.
 * The GitHub identity is part of the key because a tab stays bound to the account it was opened with.
 */
export function dashboardPanelKey(
  repositoryId: string,
  authenticatedUserId: string | undefined,
  target: { initialRunId?: number | undefined; initialView?: string | undefined; initialAction?: string | undefined; workflowPath?: string | undefined },
): string {
  const surface = target.initialRunId !== undefined ? `run:${target.initialRunId}`
    : target.initialView === "action-center" ? "action-center"
    : target.workflowPath ? `${target.initialAction ?? "companion"}:${target.workflowPath.toLowerCase()}`
    : "dashboard";
  return `${repositoryId}|${authenticatedUserId ?? ""}|${surface}`;
}
