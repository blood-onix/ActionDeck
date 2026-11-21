import React from "react";
import { computeHealthSummary, type RunResultBar } from "../utils/health-metrics";

export interface MetricCellProps {
  passRate: number | null;
  avg?: string | undefined;
  sample?: number | undefined;
  results?: readonly RunResultBar[] | undefined;
  partial?: boolean | undefined;
  passes?: number | undefined;
  failures?: number | undefined;
}

export function MetricCell({
  passRate,
  avg,
  sample = 0,
  results,
  partial,
  passes,
  failures,
}: MetricCellProps): React.JSX.Element {
  const summary = computeHealthSummary({
    passRate,
    sampleSize: sample,
    avg: avg ?? null,
    ...(results ? { results } : {}),
    ...(partial !== undefined ? { historyPartial: partial } : {}),
    ...(passes !== undefined ? { passes } : {}),
    ...(failures !== undefined ? { failures } : {}),
  });

  if (summary.kind === "none") {
    return <span className="ad-muted ad-caption">No completed runs</span>;
  }

  return (
    <span className="ad-metric" title={summary.tooltip}>
      {summary.bars.length > 0 ? (
        <span className="ad-spark" aria-hidden="true">
          {summary.bars.map((bar, index) => (
            <span key={index} className={`ad-spark__bar ad-spark__bar--${bar}`} />
          ))}
        </span>
      ) : null}
      <span className="ad-metric__text ad-num">
        <span className="ad-metric__rate">{summary.passRatePercent}%</span>
        <span className="ad-metric__sample">
          {`· ${summary.sampleSize} ${summary.sampleSize === 1 ? "run" : "runs"}${summary.partial ? "*" : ""}`}
        </span>
      </span>
    </span>
  );
}
