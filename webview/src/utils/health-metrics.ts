export type RunResultBar = "s" | "f" | "c";

export type HealthSummary =
  | {
      readonly kind: "none";
      readonly label: "No completed runs";
      readonly passRate: null;
      readonly avgDurationLabel: null;
      readonly sampleSize: 0;
      readonly bars: readonly [];
    }
  | {
      readonly kind: "computed";
      readonly passRatePercent: number;
      readonly avgDurationLabel: string;
      readonly sampleSize: number;
      readonly sampleLabel: string;
      readonly partial: boolean;
      readonly bars: readonly RunResultBar[];
      readonly tooltip: string;
    };

export interface RawHealthMetrics {
  passRate: number | null;
  sampleSize: number;
  averageDurationMs?: number | null;
  avg?: string | null;
  passes?: number;
  failures?: number;
  results?: readonly RunResultBar[];
  historyPartial?: boolean;
  historyCapped?: boolean;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function computeHealthSummary(metrics: RawHealthMetrics): HealthSummary {
  const sampleSize = Math.max(0, Math.min(20, Math.trunc(metrics.sampleSize || 0)));
  if (sampleSize === 0 || metrics.passRate === null || metrics.passRate === undefined) {
    return {
      kind: "none",
      label: "No completed runs",
      passRate: null,
      avgDurationLabel: null,
      sampleSize: 0,
      bars: [],
    };
  }

  const rawRate = metrics.passRate <= 1 && metrics.passRate >= 0 && !Number.isInteger(metrics.passRate)
    ? Math.round(metrics.passRate * 100)
    : metrics.passRate === 1 && (metrics.passes ?? 0) > 0 && (metrics.failures ?? 0) === 0
      ? 100
      : Math.round(metrics.passRate);
  const passRatePercent = Math.max(0, Math.min(100, rawRate));
  const avgDurationLabel = metrics.avg ?? formatDurationMs(metrics.averageDurationMs);
  const partial = sampleSize < 5 || Boolean(metrics.historyPartial || metrics.historyCapped);
  const sampleLabel = sampleSize < 5 ? `only ${sampleSize}` : `last ${sampleSize}`;

  let bars: RunResultBar[];
  if (metrics.results && metrics.results.length > 0) {
    bars = metrics.results.slice(0, 20);
  } else {
    const passes = Math.min(sampleSize, Math.max(0, metrics.passes ?? Math.round((passRatePercent / 100) * sampleSize)));
    const failures = Math.min(sampleSize - passes, Math.max(0, metrics.failures ?? sampleSize - passes));
    const cancelled = Math.max(0, sampleSize - passes - failures);
    bars = [
      ...Array.from({ length: passes }, (): RunResultBar => "s"),
      ...Array.from({ length: failures }, (): RunResultBar => "f"),
      ...Array.from({ length: cancelled }, (): RunResultBar => "c"),
    ];
  }

  const tooltip = `${passRatePercent}% pass · avg ${avgDurationLabel} (${sampleLabel} completed runs${partial ? ", history partial" : ""})`;

  return {
    kind: "computed",
    passRatePercent,
    avgDurationLabel,
    sampleSize,
    sampleLabel,
    partial,
    bars,
    tooltip,
  };
}
