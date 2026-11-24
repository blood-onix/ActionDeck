import { redactSensitiveText } from "./redaction";

export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_LINES = 10_000;

export function boundLogExcerpt(
  jobId: number,
  attempt: number,
  input: string,
  retrievedAt = new Date().toISOString(),
  stepNumber?: number,
): {
  jobId: number;
  attempt: number;
  text: string;
  truncated: boolean;
  retrievedAt: string;
  availability: "loaded" | "truncated";
  stepNumber?: number;
} {
  const encoder = new TextEncoder();
  let text = input.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  let truncated = false;
  let lineNumber = 1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      if (lineNumber === MAX_LOG_LINES) {
        text = text.slice(0, index);
        truncated = true;
        break;
      }
      lineNumber++;
    }
  }
  text = redactSensitiveText(text);
  while (encoder.encode(text).byteLength > MAX_LOG_BYTES) {
    text = text.slice(0, Math.floor(text.length * 0.9));
    truncated = true;
  }
  return {
    jobId,
    attempt,
    text,
    truncated,
    retrievedAt,
    availability: truncated ? "truncated" : "loaded",
    ...(stepNumber === undefined ? {} : { stepNumber }),
  };
}

export const LOG_TRUNCATION_MARKER = "[ActionDeck: log truncated at 2 MB]";

export interface StepLogTiming {
  readonly number: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly conclusion?: string | null;
}

export type StepLogLocation =
  | { readonly state: "identified"; readonly text: string }
  | { readonly state: "unidentified"; readonly reason: string };

const LOG_TIMESTAMP = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z(?:\s|$)/;

/** First line the runner prints for a step: a script or action run, an action download, a post step, or job cleanup. */
const STEP_OPENER = /^(?:##\[group\]Run\b|Prepare all required actions$|Download action repository\b|Post job cleanup\.$|Cleaning up orphan processes$)/;

function toSecond(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

interface TimedStep {
  readonly number: number;
  readonly start: number;
  readonly end: number;
}

/**
 * GitHub exposes no step markers in job logs, so a step is located by its platform-reported time window.
 * Steps often start in the same second the previous one ends; that shared second is split at the line the
 * runner prints when a step begins. Skipped steps write nothing and are left out.
 */
export function locateStepLog(
  raw: string,
  steps: readonly StepLogTiming[],
  stepNumber: number,
): StepLogLocation {
  const unidentified = (reason: string): StepLogLocation => ({ state: "unidentified", reason });
  const selected = steps.find((step) => step.number === stepNumber);
  const start = toSecond(selected?.startedAt);
  const end = toSecond(selected?.completedAt);
  if (start === undefined || end === undefined || end < start) {
    return unidentified("The step has no completed start and end time, so its log section cannot be located.");
  }

  const downloadTruncated = raw.startsWith(LOG_TRUNCATION_MARKER);
  const body = downloadTruncated ? raw.slice(LOG_TRUNCATION_MARKER.length).replace(/^\r?\n/, "") : raw;
  const lines = body.split(/\r?\n/);
  const seconds: number[] = [];
  const texts: string[] = [];
  let previous: number | undefined;
  for (const line of lines) {
    const match = LOG_TIMESTAMP.exec(line);
    texts.push(match ? line.slice(match[0].length) : line);
    const current = match ? Date.parse(`${match[1]}Z`) / 1000 : previous;
    if (current === undefined || !Number.isFinite(current)) {
      if (line.trim() === "") {
        seconds.push(Number.NaN);
        continue;
      }
      return unidentified("Log lines do not carry reliable timestamps for step boundaries.");
    }
    if (previous !== undefined && current < previous) {
      return unidentified("Log timestamps are not monotonic, so step boundaries are ambiguous.");
    }
    seconds.push(Math.floor(current));
    previous = current;
  }
  const lastSecond = previous === undefined ? undefined : Math.floor(previous);
  if (lastSecond === undefined) return unidentified("The log has no lines to locate a step in.");
  if (downloadTruncated && end >= lastSecond) {
    return unidentified("The downloaded log was truncated before this step completed.");
  }

  const timed: TimedStep[] = steps
    .flatMap((step) => {
      const stepStart = toSecond(step.startedAt);
      const stepEnd = toSecond(step.completedAt);
      if (step.conclusion === "skipped" || stepStart === undefined || stepEnd === undefined) return [];
      return [{ number: step.number, start: stepStart, end: stepEnd }];
    })
    .sort((a, b) => a.number - b.number);
  const position = timed.findIndex((step) => step.number === stepNumber);
  if (position < 0) return unidentified("The step has no log section of its own.");

  /** Index of a step's first line, or undefined when a shared second has no step marker to split it. */
  const firstLine = (index: number, after: number): number | undefined => {
    const step = timed[index]!;
    const before = timed[index - 1];
    const sharesSecond = before !== undefined && before.end >= step.start;
    for (let line = after + 1; line < lines.length; line++) {
      const second = seconds[line]!;
      if (Number.isNaN(second) || second < step.start) continue;
      if (!sharesSecond) return line;
      if (second > Math.min(step.end, step.start + 1)) return undefined;
      if (STEP_OPENER.test(texts[line]!)) return line;
    }
    return undefined;
  };

  let floor = -1;
  let first: number | undefined;
  for (let index = 0; index <= position; index++) {
    const found = firstLine(index, floor);
    if (found === undefined) {
      if (index === position) {
        return unidentified("Adjacent steps share log timestamps and no step marker separates them.");
      }
      continue;
    }
    floor = found;
    if (index === position) first = found;
  }
  if (first === undefined) return unidentified("No log lines fall within the step's reported time window.");

  let stop = lines.length;
  for (let line = first + 1; line < lines.length; line++) {
    if (seconds[line]! > end) {
      stop = line;
      break;
    }
  }
  if (timed[position + 1]) {
    const next = firstLine(position + 1, first);
    if (next === undefined && timed[position + 1]!.start <= end) {
      return unidentified("Adjacent steps share log timestamps and no step marker separates them.");
    }
    if (next !== undefined) stop = Math.min(stop, next);
  }

  const selectedLines = lines.slice(first, stop);
  while (selectedLines.length > 0 && selectedLines[selectedLines.length - 1]!.trim() === "") selectedLines.pop();
  if (selectedLines.length === 0) {
    return unidentified("No log lines fall within the step's reported time window.");
  }
  return { state: "identified", text: selectedLines.join("\n") };
}
