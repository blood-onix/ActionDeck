import * as vscode from "vscode";
import { formatRelativeTime } from "../../domain/services/relative-time";

export type WorkflowEditorAction = "companion" | "latest-run" | "pipeline";

export interface LatestRunSummary {
  readonly status: string;
  readonly conclusion: string | null;
  readonly updatedAt?: string;
}

const CODELENS_STATUS_DISPLAY: Record<string, { glyph: string; word: string }> = {
  success: { glyph: "✓", word: "Success" },
  failure: { glyph: "✕", word: "Failure" },
  timed_out: { glyph: "✕", word: "Failure" },
  startup_failure: { glyph: "✕", word: "Failure" },
  action_required: { glyph: "✕", word: "Failure" },
  cancelled: { glyph: "⊘", word: "Cancelled" },
  in_progress: { glyph: "↻", word: "Running" },
  running: { glyph: "↻", word: "Running" },
  queued: { glyph: "○", word: "Queued" },
  waiting: { glyph: "◷", word: "Waiting for Approval" },
  waiting_approval: { glyph: "◷", word: "Waiting for Approval" },
  skipped: { glyph: "↷", word: "Skipped" },
  neutral: { glyph: "↷", word: "Skipped" },
  stale: { glyph: "⚠", word: "Stale" },
};

function latestRunDisplay(summary: LatestRunSummary): { glyph: string; word: string } {
  const key = (
    summary.status === "completed" && summary.conclusion ? summary.conclusion : summary.status
  )
    .trim()
    .toLowerCase();
  return CODELENS_STATUS_DISPLAY[key] ?? { glyph: "?", word: "Outcome Uncertain" };
}

/** Status word plus relative time, e.g. "Success · 1d ago"; shared by CodeLens and the sidebar tree. */
export function latestRunLabel(summary: LatestRunSummary): string {
  const relative = formatRelativeTime(summary.updatedAt);
  return `${latestRunDisplay(summary).word}${relative ? ` · ${relative}` : ""}`;
}

function formatLatestRunStatus(summary: LatestRunSummary): string {
  const display = latestRunDisplay(summary);
  const relative = formatRelativeTime(summary.updatedAt);
  return `Last run: ${display.glyph} ${display.word}${relative ? ` · ${relative}` : ""}`;
}

export class WorkflowCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = typeof vscode.EventEmitter === "function"
    ? new vscode.EventEmitter<void>()
    : undefined;
  readonly onDidChangeCodeLenses: vscode.Event<void> = (listener, thisArgs, disposables) =>
    this.changeEmitter ? this.changeEmitter.event(listener, thisArgs, disposables) : { dispose() {} };

  constructor(
    private readonly getLatestRunSummary?: (uri: vscode.Uri) => LatestRunSummary | undefined,
    private readonly getWorkflowAvailability?: (uri: vscode.Uri) => string | undefined,
  ) {}

  refresh(): void {
    this.changeEmitter?.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isWorkflowDocument(document)) return [];
    const position = new vscode.Range(0, 0, 0, 0);
    const availability = this.getWorkflowAvailability?.(document.uri);
    const latest = this.getLatestRunSummary?.(document.uri);
    const latestTitle = latest ? formatLatestRunStatus(latest) : "Last run: Not Loaded";

    const triggerTitle =
      availability === "local_only" ? "Push to enable trigger" : "▶ Trigger workflow";

    return [
      new vscode.CodeLens(position, {
        title: triggerTitle,
        command: "actiondeck.openCompanion",
        arguments: [document.uri],
      }),
      new vscode.CodeLens(position, {
        title: "Open companion",
        command: "actiondeck.openCompanion",
        arguments: [document.uri],
      }),
      new vscode.CodeLens(position, {
        title: latestTitle,
        command: "actiondeck.openLatestWorkflowRun",
        arguments: [document.uri],
      }),
    ];
  }
}

export const WORKFLOW_FILE_PATTERN = "**/.github/workflows/*.{yml,yaml}";

/** Path-based on purpose: extensions such as GitHub Actions re-label these files with their own language ID. */
export function isWorkflowDocument(document: Pick<vscode.TextDocument, "uri">): boolean {
  return /(?:^|\/)\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(document.uri.path);
}
