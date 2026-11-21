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
}

export type StepLogLocation =
  | { readonly state: "identified"; readonly text: string }
  | { readonly state: "unidentified"; readonly reason: string };

const LOG_TIMESTAMP = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z(?:\s|$)/;

function toSecond(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

/**
 * GitHub exposes no step markers in job logs, so a step is only located when its
 * platform-reported time window owns whole log seconds that no other step shares.
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
  let previous: number | undefined;
  for (const line of lines) {
    const match = LOG_TIMESTAMP.exec(line);
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
    seconds.push(current);
    previous = current;
  }
  const lastSecond = previous;
  if (lastSecond === undefined) return unidentified("The log has no lines to locate a step in.");

  const shared = steps.some((other) => {
    if (other.number === stepNumber) return false;
    const otherStart = toSecond(other.startedAt);
    const otherEnd = toSecond(other.completedAt);
    if (otherStart === undefined || otherEnd === undefined) return false;
    return otherStart <= end && otherEnd >= start;
  });
  if (shared) {
    return unidentified("Adjacent steps share log timestamps, so this step's boundaries are ambiguous.");
  }
  if (downloadTruncated && end >= lastSecond) {
    return unidentified("The downloaded log was truncated before this step completed.");
  }

  const selectedLines = lines.filter((_, index) => {
    const second = seconds[index];
    return second !== undefined && second >= start && second <= end;
  });
  if (selectedLines.length === 0) {
    return unidentified("No log lines fall within the step's reported time window.");
  }
  return { state: "identified", text: selectedLines.join("\n") };
}
