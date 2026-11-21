/**
 * Extracts the repository-relative workflow file path from a workflow run's `path`.
 *
 * GitHub reports it in several shapes depending on the event and API version:
 *   ".github/workflows/ci.yml"
 *   ".github/workflows/ci.yml@refs/heads/main"
 *   "owner/repo/.github/workflows/ci.yml@refs/heads/main"
 * Dynamic runs (e.g. "dynamic/pages/pages-build-deployment") have no file and yield undefined.
 */
export function workflowPathFromRunPath(path: string | null | undefined): string | undefined {
  return path?.trim().match(/(?:^|\/)(\.github\/workflows\/[^/@]+\.ya?ml)(?:@.*)?$/i)?.[1];
}
