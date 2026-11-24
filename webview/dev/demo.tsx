// Browser-only demo harness used to capture README screenshots.
// Every repository, workflow, branch and user name below is invented. Keep it that way.
// Run: npx vite --config webview/vite.config.mts, then open
//   /dev/demo.html?view=dashboard|plans|pipeline|run|companion|action-center&theme=deck|light
import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "../src/dashboard/Dashboard";
import type { Bridge } from "../src/bridge";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "dashboard";
const theme = params.get("theme") ?? "deck";

const THEMES: Record<string, Record<string, string>> = {
  deck: {
    "editor-background": "#262b34",
    "sideBar-background": "#21252d",
    "editorWidget-background": "#2c313b",
    "list-hoverBackground": "#30363f",
    "list-activeSelectionBackground": "#343b47",
    "list-focusOutline": "#f5c542",
    "input-background": "#21252d",
    "panel-border": "#363c47",
    "input-border": "#454c58",
    foreground: "#d4d7dc",
    descriptionForeground: "#8b929e",
    "button-background": "#f5c542",
    "button-hoverBackground": "#ffd25e",
    "button-foreground": "#1e1e1e",
    "button-secondaryBackground": "#343b47",
    "button-secondaryForeground": "#d4d7dc",
    "textLink-foreground": "#6cb6ff",
    focusBorder: "#f5c542",
    "testing-iconPassed": "#73c991",
    errorForeground: "#f85149",
    "editorWarning-foreground": "#d18616",
    "charts-blue": "#3794ff",
    "charts-purple": "#b180d7",
    "charts-orange": "#d18616",
    "badge-background": "#454c58",
    "badge-foreground": "#e6e6e6",
    "widget-shadow": "rgba(0,0,0,.45)",
  },
  light: {
    "editor-background": "#ffffff",
    "sideBar-background": "#f8f8f8",
    "editorWidget-background": "#f8f8f8",
    "list-hoverBackground": "#f2f2f2",
    "list-activeSelectionBackground": "#e8e8e8",
    "panel-border": "#e5e5e5",
    "input-background": "#ffffff",
    "input-border": "#cecece",
    foreground: "#3b3b3b",
    descriptionForeground: "#717171",
    "button-background": "#005fb8",
    "button-foreground": "#ffffff",
    focusBorder: "#005fb8",
    "testing-iconPassed": "#388a34",
    errorForeground: "#e51400",
  },
};

const root = document.documentElement;
root.style.setProperty("--vscode-font-family", '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif');
root.style.setProperty("--vscode-editor-font-family", 'Menlo, Monaco, "Courier New", monospace');
root.style.setProperty("--vscode-font-size", "13px");
for (const [key, value] of Object.entries(THEMES[theme] ?? THEMES.deck!)) {
  root.style.setProperty(`--vscode-${key}`, value);
}
document.body.classList.add(theme === "light" ? "vscode-light" : "vscode-dark");

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ME = "jdoe-dev";
const OWNER = "acme-demo";
const REPO = "storefront";
const REPO_ID = `${OWNER}/${REPO}`;

const FAILED_RUN = 7_300_100_200;
const WAITING_RUN = 7_300_100_500;

type Row = Record<string, unknown>;
const metrics = (passes: number, failures: number, avgSec: number) => ({
  passes, failures, sampleSize: passes + failures, scope: "recent",
  passRate: passes + failures ? passes / (passes + failures) : null, averageDurationMs: avgSec * 1000,
});

const workflows: Row[] = [
  {
    id: "wf-ci", workflowId: 201, latestRunId: 7_300_100_101, state: "active", historyHydration: "loaded",
    name: "CI", path: ".github/workflows/ci.yml", folder: "Build & test", availability: "synced",
    status: "success", title: "feat: share wishlists with a link", branch: "feat/wishlist-sharing", actor: ME, isMyRun: true,
    duration: "3m 12s", metrics: metrics(46, 2, 188), latestConclusion: "success", latestRunAt: ago(6 * MIN), notificationMode: "my_runs_only",
  },
  {
    id: "wf-e2e", workflowId: 202, latestRunId: 7_300_100_102, state: "active", historyHydration: "loaded",
    name: "e2e-tests", path: ".github/workflows/e2e-tests.yml", folder: "Build & test", availability: "synced",
    status: "in_progress", title: "fix: round cart totals per line item", branch: "fix/cart-rounding", actor: "octo-sam", isMyRun: false,
    duration: "4m 05s", metrics: metrics(18, 3, 402), latestConclusion: null, latestRunAt: ago(4 * MIN), notificationMode: "all_runs",
  },
  {
    id: "wf-lint", workflowId: 203, latestRunId: 7_300_100_103, state: "active", historyHydration: "loaded",
    name: "lint", path: ".github/workflows/lint.yml", folder: "Build & test", availability: "synced",
    status: "success", title: "chore(deps): bump vite from 6.3.2 to 6.4.1", branch: "dependabot/npm/vite-6.4.1", actor: "dependabot[bot]", isMyRun: false,
    duration: "41s", metrics: metrics(52, 0, 39), latestConclusion: "success", latestRunAt: ago(35 * MIN), notificationMode: "muted",
  },
  {
    id: "wf-staging", workflowId: 204, latestRunId: 7_300_100_104, state: "active", historyHydration: "loaded",
    name: "deploy-staging", path: ".github/workflows/deploy-staging.yml", folder: "Deploy", availability: "synced",
    status: "success", title: "Deploy main to staging", branch: "main", actor: ME, isMyRun: true,
    duration: "2m 47s", metrics: metrics(29, 1, 171), latestConclusion: "success", latestRunAt: ago(52 * MIN), notificationMode: "my_runs_only",
  },
  {
    id: "wf-prod", workflowId: 205, latestRunId: WAITING_RUN, state: "active", historyHydration: "loaded",
    name: "deploy-production", path: ".github/workflows/deploy-production.yml", folder: "Deploy", availability: "synced",
    status: "waiting", title: "Release v2.8.0 to production", branch: "release/2.8", actor: ME, isMyRun: true,
    duration: "1m 02s", metrics: metrics(14, 1, 318), latestConclusion: null, latestRunAt: ago(9 * MIN), notificationMode: "my_runs_only",
  },
  {
    id: "wf-preview", workflowId: 206, latestRunId: 7_300_100_106, state: "active", historyHydration: "loaded",
    name: "preview-environments", path: ".github/workflows/preview-environments.yml", folder: "Deploy", availability: "synced",
    status: "success", title: "feat: product comparison table", branch: "feat/compare-products", actor: "pixel-kai", isMyRun: false,
    duration: "2m 10s", metrics: metrics(33, 4, 140), latestConclusion: "success", latestRunAt: ago(3 * HOUR), notificationMode: "all_runs",
  },
  {
    id: "wf-release", workflowId: 207, latestRunId: 7_300_100_107, state: "active", historyHydration: "loaded",
    name: "release", path: ".github/workflows/release.yml", folder: "Release", availability: "synced",
    status: "success", title: "Release v2.8.0", branch: "release/2.8", actor: ME, isMyRun: true,
    duration: "1m 38s", metrics: metrics(11, 0, 95), latestConclusion: "success", latestRunAt: ago(25 * MIN), notificationMode: "my_runs_only",
  },
  {
    id: "wf-docker", workflowId: 208, latestRunId: FAILED_RUN, state: "active", historyHydration: "loaded",
    name: "publish-docker", path: ".github/workflows/publish-docker.yml", folder: "Release", availability: "synced",
    status: "failure", title: "Release v2.8.0", branch: "release/2.8", actor: ME, isMyRun: true,
    duration: "2m 03s", metrics: metrics(9, 3, 131), latestConclusion: "failure", latestRunAt: ago(21 * MIN), notificationMode: "my_runs_only",
  },
  {
    id: "wf-scan", workflowId: 209, latestRunId: 7_300_100_109, state: "active", historyHydration: "loaded",
    name: "nightly-security-scan", path: ".github/workflows/nightly-security-scan.yml", folder: "Maintenance", availability: "synced",
    status: "success", title: "Scheduled scan", branch: "main", actor: "github-actions[bot]", isMyRun: false,
    duration: "6m 20s", metrics: metrics(20, 0, 371), latestConclusion: "success", latestRunAt: ago(9 * HOUR), notificationMode: "muted",
  },
  {
    id: "wf-deps", workflowId: 210, latestRunId: 7_300_100_110, state: "active", historyHydration: "loaded",
    name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates", folder: "Maintenance", availability: "remote_only",
    status: "success", title: "npm in /. - Update #4182", branch: "main", actor: "dependabot[bot]", isMyRun: false,
    duration: "58s", metrics: metrics(24, 1, 61), latestConclusion: "success", latestRunAt: ago(2 * DAY), notificationMode: "muted",
  },
  {
    id: "wf-stale", state: "active", historyHydration: "not_loaded",
    name: "stale-issues", path: ".github/workflows/stale-issues.yml", folder: "Maintenance", availability: "local_only",
    status: "not_loaded", title: "—", branch: "—", actor: "—", isMyRun: false, duration: "—",
    metrics: { passes: 0, failures: 0, sampleSize: 0, scope: "recent", passRate: null, averageDurationMs: null },
  },
];

const TITLES = [
  "feat: share wishlists with a link",
  "fix: round cart totals per line item",
  "chore(deps): bump vite from 6.3.2 to 6.4.1",
  "Release v2.8.0",
  "feat: product comparison table",
  "refactor: extract checkout summary",
  "fix: keep filters when paging search results",
];
const BRANCHES = ["main", "feat/wishlist-sharing", "fix/cart-rounding", "release/2.8", "feat/compare-products"];
const ACTORS = [ME, "octo-sam", "pixel-kai", ME, "dependabot[bot]"];

function makeRuns(workflowId: number) {
  const pattern = workflowId === 208
    ? ["failure", "success", "success", "failure", "success", "success", "success", "cancelled", "success", "success", "failure", "success", "success", "success", "success", "success", "success", "success"]
    : Array.from({ length: 22 }, (_, i) => (i === 7 ? "failure" : i === 13 ? "cancelled" : "success"));
  const durations = [123, 131, 118, 140, 126, 129, 135, 44, 128, 121, 76, 133, 130, 127, 125, 138, 129, 124, 132, 126, 130, 128];
  return pattern.map((conclusion, index) => {
    const created = now - (index === 0 ? 21 * MIN : index * 7 * HOUR + DAY);
    const queue = 3_000 + (index % 4) * 2_000;
    const duration = durations[index % durations.length]! * 1000;
    return {
      id: (workflowId === 208 ? FAILED_RUN : 7_200_000_000 + workflowId * 1000) - index * 977,
      workflowId,
      attemptCount: 1,
      hydration: "summary",
      displayTitle: TITLES[index % TITLES.length]!,
      status: "completed",
      conclusion,
      event: index % 3 === 0 ? "workflow_dispatch" : index % 3 === 1 ? "push" : "pull_request",
      branch: BRANCHES[index % BRANCHES.length]!,
      headSha: "4f2c9e1a7b",
      actor: { login: ACTORS[index % ACTORS.length]! },
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created + queue + duration).toISOString(),
      runStartedAt: new Date(created + queue).toISOString(),
      completedAt: new Date(created + queue + duration).toISOString(),
      htmlUrl: "https://github.com/acme-demo/storefront/actions",
    };
  });
}

const LOG = [
  "2026-11-20T09:41:02.0000000Z ##[group]Run ./scripts/smoke-test.sh ghcr.io/acme-demo/storefront:2.8.0",
  "2026-11-20T09:41:02.1000000Z Starting container storefront-smoke...",
  "2026-11-20T09:41:04.3000000Z Waiting for http://localhost:8080/healthz (timeout 60s)",
  "2026-11-20T09:41:09.5000000Z   attempt 1: 503 Service Unavailable",
  "2026-11-20T09:41:14.6000000Z   attempt 2: 503 Service Unavailable",
  "2026-11-20T09:41:19.8000000Z   attempt 3: 503 Service Unavailable",
  "2026-11-20T09:41:20.0000000Z Container logs:",
  "2026-11-20T09:41:20.1000000Z   [storefront] Error: required environment variable PAYMENTS_API_URL is not set",
  "2026-11-20T09:41:20.2000000Z   [storefront] Shutting down (exit code 1)",
  "2026-11-20T09:41:20.3000000Z ##[endgroup]",
  "2026-11-20T09:41:20.4000000Z ##[error]Smoke test failed: service never became healthy.",
  "2026-11-20T09:41:20.5000000Z ##[error]Process completed with exit code 1.",
].join("\n");

function inspection(runId: number) {
  const steps = ["Set up job", "Checkout", "Set up QEMU", "Set up Docker Buildx", "Log in to ghcr.io", "Extract image metadata", "Build image", "Run smoke tests", "Push image", "Post Log in to ghcr.io", "Complete job"];
  const durations = [2, 3, 6, 4, 1, 1, 88, 18, 0, 1, 0];
  const failed = runId === FAILED_RUN;
  let t = now - 21 * MIN;
  return {
    runId, attempt: 1, attemptCount: 1,
    title: "Release v2.8.0", status: "completed", conclusion: failed ? "failure" : "success",
    htmlUrl: "https://github.com/acme-demo/storefront/actions", workflowId: 208,
    workflowPath: ".github/workflows/publish-docker.yml", ref: "release/2.8",
    headSha: "4f2c9e1a7b", actor: ME, isMyRun: true, createdAt: ago(21 * MIN),
    dispatchInputs: [
      { name: "version", value: "2.8.0" },
      { name: "platforms", value: "linux/amd64,linux/arm64" },
    ],
    dependencyResolution: "resolved",
    jobs: [{
      id: 9101, runId, attempt: 1, name: "Build and publish image", status: "completed",
      conclusion: failed ? "failure" : "success", startedAt: ago(21 * MIN), completedAt: new Date(now - 21 * MIN + 124_000).toISOString(),
      steps: steps.map((name, index) => {
        const start = t;
        t += durations[index]! * 1000;
        const conclusion = failed && index === 7 ? "failure" : failed && index === 8 ? "skipped" : "success";
        return { number: index + 1, name, status: "completed", conclusion, startedAt: new Date(start).toISOString(), completedAt: new Date(t).toISOString() };
      }),
    }],
  };
}

const step = (id: string, workflowId: number, workflowPath: string, state: string, extra: Row = {}) => ({
  id, workflowId, workflowPath, ref: "release/2.8", inputs: { version: "2.8.0" }, sensitiveInputKeys: [],
  gate: "on_success", state, ...extra,
});

const plans = [
  {
    id: "plan-weekly", name: "Weekly release v2.8.0", repositoryId: REPO_ID, state: "waiting_approval", currentStepIndex: 4,
    updatedAt: now - 9 * MIN,
    steps: [
      step("s1", 207, ".github/workflows/release.yml", "completed", { runId: 7_300_100_107, conclusion: "success" }),
      step("s2", 208, ".github/workflows/publish-docker.yml", "completed", { runId: 7_300_100_199, conclusion: "success" }),
      step("s3", 206, ".github/workflows/preview-environments.yml", "completed", {
        runId: 7_300_100_198, conclusion: "success", parallelWithPrevious: true,
      }),
      step("s4", 204, ".github/workflows/deploy-staging.yml", "completed", { runId: 7_300_100_104, conclusion: "success" }),
      step("s5", 205, ".github/workflows/deploy-production.yml", "waiting_approval", {
        runId: WAITING_RUN, waitBeforeMinutes: 15, confirmBefore: true,
      }),
    ],
  },
  {
    id: "plan-hotfix", name: "Friday hotfix rollout", repositoryId: REPO_ID, state: "scheduled", currentStepIndex: 0,
    updatedAt: now - 2 * HOUR,
    schedule: { kind: "absolute", runAtMs: now + 5 * HOUR, timeZone: "UTC" },
    steps: [
      step("h1", 201, ".github/workflows/ci.yml", "pending"),
      step("h2", 202, ".github/workflows/e2e-tests.yml", "pending", { parallelWithPrevious: true }),
      step("h3", 204, ".github/workflows/deploy-staging.yml", "pending", { gate: "on_any_completion" }),
      step("h4", 205, ".github/workflows/deploy-production.yml", "pending", { confirmBefore: true }),
    ],
  },
];

const dispatchInputs = [
  { name: "version", type: "string", description: "Version to deploy", required: true, defaultValue: "2.8.0", sourceRef: "main" },
  { name: "region", type: "choice", description: "Target region", required: true, defaultValue: "eu-west", options: ["eu-west", "us-east", "ap-south"], sourceRef: "main" },
  { name: "canary", type: "boolean", description: "Roll out to 10% of traffic first", required: false, defaultValue: "true", sourceRef: "main" },
  { name: "notes", type: "string", description: "Release notes for the deployment log", required: false, sourceRef: "main" },
];

function respond(operation: string, payload: Record<string, unknown>): unknown {
  switch (operation) {
    case "dashboard.load":
      return {
        repository: { owner: OWNER, repo: REPO, authenticatedUserId: "1" },
        workflows,
        customGroups: [],
        ...(view === "plans" || view === "action-center" ? { plans } : {}),
        approvalRules: [
          { id: "rule-1", repositoryId: REPO_ID, workflowId: 204, environmentName: "staging", ref: "main", authenticatedUserId: "1", enabled: true, createdAt: now - 12 * DAY },
        ],
        approvalAudit: [
          { timestamp: now - 52 * MIN, repositoryId: REPO_ID, runId: 7_300_100_104, workflowId: 204, environmentId: 11, environmentName: "staging", ruleId: "rule-1", status: "succeeded" },
        ],
        ...(view === "pipeline" ? { initialWorkflowPath: ".github/workflows/publish-docker.yml", initialAction: "pipeline" } : {}),
        ...(view === "companion" ? { initialWorkflowPath: ".github/workflows/deploy-production.yml", initialAction: "companion" } : {}),
        ...(view === "run" ? { initialRunId: FAILED_RUN } : {}),
        ...(view === "action-center" ? { initialView: "action-center" } : {}),
      };
    case "workflow.history.load": {
      const runs = makeRuns(Number(payload.workflowId));
      return { runs, metrics: { passes: 0, failures: 0, sampleSize: runs.length, passRate: null, averageDurationMs: null }, hasMore: false, page: 1, totalCount: runs.length };
    }
    case "run.inspect":
      return inspection(Number(payload.runId));
    case "run.logs.load":
      return { text: LOG, truncated: false, availability: "loaded", stepNumber: 8, stepBoundary: "identified" };
    case "repository.branches":
      return { names: ["main", "develop", "release/2.8", "release/2.7", "feat/wishlist-sharing", "fix/cart-rounding", "feat/compare-products"], truncated: false, cachedAt: now, current: "main" };
    case "workflow.localPreview":
      return { workflowPath: payload.workflowPath, dispatchable: true, inputs: [], warning: "" };
    case "dispatch.validate": {
      const workflowId = Number(payload.workflowId);
      const inputs = (payload.inputs ?? {}) as Record<string, string>;
      return {
        target: { state: "available", workflowId, ref: String(payload.ref || "main"), sha: "4f2c9e1a7b", inputs: dispatchInputs },
        validation: { valid: true, values: inputs, errors: {} },
        reviewToken: "token",
      };
    }
    case "deployment.list":
      return {
        runId: Number(payload.runId),
        environments: [
          { environmentId: 12, environmentName: "production", eligible: true, currentUserCanApprove: true, waitTimerRemainingSeconds: 0, requiredReviewers: ["release-managers"] },
        ],
      };
    case "settings.cachedCards":
      return { cards: [] };
    default:
      return {};
  }
}

const bridge: Bridge = {
  request<T>(operation: string, payload: Record<string, unknown>) {
    return new Promise<T>((resolve) => setTimeout(() => resolve(respond(operation, payload ?? {}) as T), 60));
  },
  onEvent() {
    return () => undefined;
  },
};

createRoot(document.getElementById("root")!).render(<Dashboard bridge={bridge} />);
