/**
 * Pure helpers that turn a raw GitHub Actions job log into compact display lines:
 * timestamps are split off, ANSI SGR escapes become styled segments and the
 * `##[group]` / `##[command]` / `##[error]` workflow markers are interpreted.
 */

export type LogLineKind = "step" | "cmd" | "warning" | "error";

export interface AnsiSegment {
  text: string;
  fg?: string | undefined;
  bold?: boolean | undefined;
}

export interface LogLine {
  /** 1-based line number in the original log (matches GitHub's L123 anchors). */
  n?: number | undefined;
  /** Display text: no timestamp, no ANSI escapes, no workflow marker. */
  text: string;
  /** Original line, used for copying. */
  raw?: string | undefined;
  /** ISO timestamp emitted by the runner, when present. */
  time?: string | undefined;
  /** Local wall-clock time (HH:MM:SS) derived from `time`. */
  clock?: string | undefined;
  kind?: LogLineKind | undefined;
  /** Styled segments when the line carried ANSI colors. */
  segments?: AnsiSegment[] | undefined;
  /** Index (in the parsed array) of the `##[group]` header this line belongs to. */
  group?: number | undefined;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?/;
// SGR sequences, with or without the ESC byte (some pipelines drop it and leave "[31m").
const SGR = /(?:(?:\u001b\[|\u009b)(\d{1,3}(?:;\d{1,3})*)?|\[(\d{1,3}(?:;\d{1,3})*))m/g;
const OTHER_CSI = /\u001b\[[0-9;?]*[A-Za-ln-z]/g;
const WORKFLOW_CMD_ERROR = /^::error(?:\s+[^:]*)?::/i;
const WORKFLOW_CMD_WARNING = /^::warning(?:\s+[^:]*)?::/i;
const HEURISTIC_ERROR =
  /^\s*(?:[│|>*•-]\s*)?(?:\[(?:error|fatal|fail(?:ed)?)\]|(?:error|fatal|failure|failed)(?:\[[^\]]+\])?\s*:|npm\s+err!|traceback\s+\(most recent call last\):)|\bexit (?:code|status)\s+[1-9]\d*\b|\b(?:failed to|command failed|build failed|tests? failed|assertion failed)\b|\b(?:already exists|conflict)\b/i;
const RUNNER_STEP_META = /^(?:shell:\s|with:\s*$)/;

const FG: Record<number, string> = {
  30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "gray", 91: "red", 92: "green", 93: "yellow", 94: "blue", 95: "magenta", 96: "cyan", 97: "white",
};

export function stripAnsi(text: string): string {
  return text.replace(OTHER_CSI, "").replace(SGR, "");
}

export function parseAnsi(text: string): { text: string; segments?: AnsiSegment[] } {
  const cleaned = text.replace(OTHER_CSI, "");
  SGR.lastIndex = 0;
  if (!SGR.test(cleaned)) return { text: cleaned };
  SGR.lastIndex = 0;

  const segments: AnsiSegment[] = [];
  let fg: string | undefined;
  let bold = false;
  let last = 0;
  let plain = "";
  const push = (chunk: string) => {
    if (!chunk) return;
    plain += chunk;
    const prev = segments[segments.length - 1];
    if (prev && prev.fg === fg && Boolean(prev.bold) === bold) prev.text += chunk;
    else segments.push({ text: chunk, ...(fg ? { fg } : {}), ...(bold ? { bold } : {}) });
  };

  for (let match = SGR.exec(cleaned); match; match = SGR.exec(cleaned)) {
    push(cleaned.slice(last, match.index));
    last = match.index + match[0].length;
    const codes = (match[1] ?? match[2] ?? "0").split(";").map(Number);
    for (const code of codes) {
      if (code === 0) { fg = undefined; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) fg = undefined;
      else if (FG[code]) fg = FG[code];
    }
  }
  push(cleaned.slice(last));
  return segments.some((s) => s.fg || s.bold) ? { text: plain, segments } : { text: plain };
}

function localClock(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function parseLogLines(text: string): LogLine[] {
  if (!text) return [];
  const out: LogLine[] = [];
  let openGroup: number | undefined;
  const heuristicErrorLines = new Set<number>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    let rest = rawLine;
    let time: string | undefined;
    const ts = TIMESTAMP.exec(rest);
    if (ts) {
      time = ts[1];
      rest = rest.slice(ts[0].length);
    }

    const { text: body, segments } = parseAnsi(rest);

    if (body.startsWith("##[endgroup]")) {
      if (openGroup !== undefined) {
        clearRunnerEchoErrors(out, openGroup, heuristicErrorLines);
      }
      openGroup = undefined;
      return;
    }

    let kind: LogLineKind | undefined;
    let display = body;
    let segs = segments;
    let isHeuristicError = false;
    const marker = /^##\[(group|command|error|warning|notice|debug)\]/.exec(body);
    if (marker) {
      display = body.slice(marker[0].length);
      segs = segments ? parseAnsi(rest.replace(/##\[[a-z]+\]/, "")).segments : undefined;
      const name = marker[1];
      kind = name === "group" ? "step" : name === "command" ? "cmd" : name === "error" ? "error" : name === "warning" ? "warning" : undefined;
    } else if (WORKFLOW_CMD_ERROR.test(body)) {
      kind = "error";
    } else if (WORKFLOW_CMD_WARNING.test(body)) {
      kind = "warning";
    } else if (body.startsWith("$ ")) {
      kind = "cmd";
    } else if (HEURISTIC_ERROR.test(body)) {
      kind = "error";
      isHeuristicError = true;
    }

    const line: LogLine = {
      n: index + 1,
      text: display,
      raw: rawLine,
      ...(time ? { time, clock: localClock(time) } : {}),
      ...(kind ? { kind } : {}),
      ...(segs ? { segments: segs } : {}),
    };

    if (kind === "step") {
      openGroup = out.length;
    } else if (openGroup !== undefined) {
      line.group = openGroup;
    }
    if (isHeuristicError) heuristicErrorLines.add(out.length);
    out.push(line);
  });

  if (openGroup !== undefined) {
    clearRunnerEchoErrors(out, openGroup, heuristicErrorLines);
  }

  return out;
}

/**
 * GitHub Actions echoes a step's script/inputs/env inside a `##[group]Run ...` block
 * followed by `shell:` or `with:`. That block is step definition echo, not runtime output,
 * so heuristic error matches inside it should not be highlighted or auto-expand the group.
 */
function clearRunnerEchoErrors(lines: LogLine[], groupIndex: number, heuristicErrorLines: ReadonlySet<number>): void {
  const header = lines[groupIndex];
  if (!header?.text.startsWith("Run ")) return;
  let isRunnerEcho = false;
  for (let i = groupIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.group !== groupIndex) continue;
    if (RUNNER_STEP_META.test(line.text)) {
      isRunnerEcho = true;
      break;
    }
  }
  if (!isRunnerEcho) return;
  for (let i = groupIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.group === groupIndex && heuristicErrorLines.has(i)) {
      delete line.kind;
    }
  }
}
