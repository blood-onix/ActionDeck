import type { Tone } from "../components/Icon";

export type { Tone };

export type Status =
  | "success"
  | "failure"
  | "cancelled"
  | "running"
  | "queued"
  | "waiting_approval"
  | "skipped"
  | "restricted"
  | "outcome_uncertain"
  | "stale"
  | "not_loaded"
  | "paused"
  | "scheduled"
  | "missed_schedule"
  | "on_hold"
  | "blocked";

export interface StatusDescriptor {
  readonly status: Status;
  readonly label: string;
  readonly codicon: string;
  readonly tone: Tone;
  readonly spin?: boolean;
}

export const STATUS_DESCRIPTORS: Record<Status, StatusDescriptor> = {
  success: {
    status: "success",
    label: "Success",
    codicon: "pass-filled",
    tone: "success",
    spin: false,
  },
  failure: {
    status: "failure",
    label: "Failure",
    codicon: "error",
    tone: "failure",
    spin: false,
  },
  cancelled: {
    status: "cancelled",
    label: "Cancelled",
    codicon: "circle-slash",
    tone: "muted",
    spin: false,
  },
  running: {
    status: "running",
    label: "Running",
    codicon: "sync",
    tone: "running",
    spin: true,
  },
  queued: {
    status: "queued",
    label: "Queued",
    codicon: "circle-large-outline",
    tone: "muted",
    spin: false,
  },
  on_hold: {
    status: "on_hold",
    label: "Waiting to Continue",
    codicon: "watch",
    tone: "warning",
    spin: false,
  },
  waiting_approval: {
    status: "waiting_approval",
    label: "Waiting for Approval",
    codicon: "watch",
    tone: "warning",
    spin: false,
  },
  skipped: {
    status: "skipped",
    label: "Skipped",
    codicon: "debug-step-over",
    tone: "muted",
    spin: false,
  },
  restricted: {
    status: "restricted",
    label: "Restricted",
    codicon: "lock",
    tone: "restricted",
    spin: false,
  },
  outcome_uncertain: {
    status: "outcome_uncertain",
    label: "Outcome Uncertain",
    codicon: "question",
    tone: "uncertain",
    spin: false,
  },
  stale: {
    status: "stale",
    label: "Stale",
    codicon: "warning",
    tone: "warning",
    spin: false,
  },
  not_loaded: {
    status: "not_loaded",
    label: "Not Loaded",
    codicon: "circle-small",
    tone: "muted",
    spin: false,
  },
  paused: {
    status: "paused",
    label: "Paused",
    codicon: "debug-pause",
    tone: "muted",
    spin: false,
  },
  scheduled: {
    status: "scheduled",
    label: "Scheduled",
    codicon: "calendar",
    tone: "running",
    spin: false,
  },
  missed_schedule: {
    status: "missed_schedule",
    label: "Missed Schedule",
    codicon: "history",
    tone: "uncertain",
    spin: false,
  },
  blocked: {
    status: "blocked",
    label: "Blocked",
    codicon: "stop-circle",
    tone: "warning",
    spin: false,
  },
};

const RAW_STATUS_MAP: Record<string, Status> = {
  success: "success",
  completed: "success",
  succeeded: "success",
  failure: "failure",
  failed: "failure",
  timed_out: "failure",
  startup_failure: "failure",
  action_required: "failure",
  cancelled: "cancelled",
  canceled: "cancelled",
  stopped: "cancelled",
  running: "running",
  in_progress: "running",
  dispatching: "running",
  request_accepted: "running",
  queued: "queued",
  requested: "queued",
  pending: "queued",
  draft: "queued",
  waiting_approval: "waiting_approval",
  waiting: "waiting_approval",
  skipped: "skipped",
  neutral: "skipped",
  restricted: "restricted",
  access_restricted: "restricted",
  permission_restricted: "restricted",
  outcome_uncertain: "outcome_uncertain",
  stale: "stale",
  partial_stale: "stale",
  not_loaded: "not_loaded",
  run_info_not_loaded: "not_loaded",
  "—": "not_loaded",
  "-": "not_loaded",
  paused: "paused",
  scheduled: "scheduled",
  missed_schedule: "missed_schedule",
  on_hold: "on_hold",
  blocked: "blocked",
  blocked_uncertain: "blocked",
};

export function normalizeStatus(
  raw: string | null | undefined,
  conclusion?: string | null,
): Status {
  // Dashboard rows carry "status / conclusion" (e.g. "completed / success") in one string.
  const combined = conclusion === undefined ? raw?.split(" / ") : undefined;
  if (combined && combined.length === 2) return normalizeStatus(combined[0], combined[1]);
  const rawLower = raw?.trim().toLowerCase() ?? "";
  if (rawLower === "completed" && conclusion) {
    const concLower = conclusion.trim().toLowerCase();
    if (concLower in RAW_STATUS_MAP) {
      return RAW_STATUS_MAP[concLower]!;
    }
    return "outcome_uncertain";
  }
  if (rawLower in RAW_STATUS_MAP) {
    return RAW_STATUS_MAP[rawLower]!;
  }
  return "outcome_uncertain";
}

export type Availability =
  | "synced"
  | "remote_only"
  | "local_only"
  | "disabled"
  | "invalid_yaml"
  | "never_run"
  | "access_restricted";

export interface AvailabilityDescriptor {
  readonly value: Availability;
  readonly label: string;
  readonly codicon: string;
  readonly tone: "muted" | "failure" | "restricted";
  readonly alert: boolean;
  readonly disableTriggerReason?: string;
}

const AVAILABILITY_DESCRIPTORS: Record<Availability, AvailabilityDescriptor> = {
  synced: {
    value: "synced",
    label: "Synced",
    codicon: "check",
    tone: "muted",
    alert: false,
  },
  remote_only: {
    value: "remote_only",
    label: "Remote-Only",
    codicon: "cloud",
    tone: "muted",
    alert: false,
  },
  local_only: {
    value: "local_only",
    label: "Local-Only",
    codicon: "file",
    tone: "muted",
    alert: false,
    disableTriggerReason: "Push this workflow to run it",
  },
  disabled: {
    value: "disabled",
    label: "Disabled",
    codicon: "circle-slash",
    tone: "muted",
    alert: false,
  },
  invalid_yaml: {
    value: "invalid_yaml",
    label: "Invalid YAML",
    codicon: "warning",
    tone: "failure",
    alert: true,
  },
  never_run: {
    value: "never_run",
    label: "Never Run",
    codicon: "dash",
    tone: "muted",
    alert: false,
  },
  access_restricted: {
    value: "access_restricted",
    label: "Access Restricted",
    codicon: "lock",
    tone: "restricted",
    alert: true,
  },
};

export function mapWorkflowAvailability(raw: string | null | undefined): AvailabilityDescriptor {
  const key = (raw ?? "synced").trim().toLowerCase();
  if (key in AVAILABILITY_DESCRIPTORS) {
    return AVAILABILITY_DESCRIPTORS[key as Availability];
  }
  if (key === "run_info_not_loaded" || key === "partial_stale") {
    return AVAILABILITY_DESCRIPTORS.synced;
  }
  return AVAILABILITY_DESCRIPTORS.synced;
}
