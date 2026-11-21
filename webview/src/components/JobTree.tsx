import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { StatusLabel } from "./StatusLabel";
import type { Status } from "../utils/status";

export interface JobTreeStep {
  id?: string | number;
  number: number;
  name: string;
  status: Status | string;
  duration?: string | undefined;
  active?: boolean | undefined;
}

export interface JobTreeJob {
  id: number;
  name: string;
  status: Status | string;
  duration?: string | undefined;
  expanded?: boolean | undefined;
  active?: boolean | undefined;
  needs?: readonly string[] | undefined;
  steps?: readonly JobTreeStep[] | undefined;
}

export interface JobTreeProps {
  jobs: readonly JobTreeJob[];
  activeJobId?: number | undefined;
  activeStepNumber?: number | undefined;
  onSelectJob?: ((jobId: number) => void) | undefined;
  onSelectStep?: ((jobId: number, stepNumber: number) => void) | undefined;
  still?: boolean | undefined;
}

export function JobTree({
  jobs,
  activeJobId,
  activeStepNumber,
  onSelectJob,
  onSelectStep,
  still = false,
}: JobTreeProps): React.JSX.Element {
  const [expandedIds, setExpandedIds] = useState<number[]>(() => {
    const initial = new Set<number>();
    for (const job of jobs) {
      if (job.expanded) initial.add(job.id);
    }
    if (initial.size === 0) {
      const firstFailed = jobs.find((job) => job.status === "failure");
      if (firstFailed) initial.add(firstFailed.id);
      else if (jobs[0]) initial.add(jobs[0].id);
    }
    return [...initial];
  });

  const treeRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const firstFailed = jobs.find((job) => job.status === "failure");
    if (firstFailed && !expandedIds.includes(firstFailed.id)) {
      setExpandedIds((prev) => [...prev, firstFailed.id]);
    }
  }, [jobs]);

  function toggleExpand(jobId: number) {
    setExpandedIds((prev) =>
      prev.includes(jobId) ? prev.filter((id) => id !== jobId) : [...prev, jobId],
    );
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const current =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[role="treeitem"]')
        : null;
    if (!current) return;
    const index = items.indexOf(current);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = items[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }

    const jobIdAttr = current.dataset.jobId;
    const stepNumAttr = current.dataset.stepNumber;
    const jobId = jobIdAttr ? Number(jobIdAttr) : undefined;

    if (jobId !== undefined && stepNumAttr === undefined) {
      const isExpanded = expandedIds.includes(jobId);
      if (event.key === "ArrowRight" && !isExpanded) {
        event.preventDefault();
        toggleExpand(jobId);
      } else if (event.key === "ArrowLeft" && isExpanded) {
        event.preventDefault();
        toggleExpand(jobId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectJob?.(jobId);
      }
      return;
    }

    if (jobId !== undefined && stepNumAttr !== undefined) {
      if (event.key === "ArrowLeft") {
        const parentJob = items.find(
          (el) => el.dataset.jobId === String(jobId) && el.dataset.stepNumber === undefined,
        );
        if (parentJob) {
          event.preventDefault();
          parentJob.focus();
        }
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectStep?.(jobId, Number(stepNumAttr));
      }
    }
  }

  return (
    <ul
      ref={treeRef}
      className="ad-tree"
      role="tree"
      aria-label="Jobs and steps"
      onKeyDown={handleKeyDown}
    >
      {jobs.map((job) => {
        const isExpanded = expandedIds.includes(job.id);
        const isJobActive =
          job.active || (activeJobId === job.id && activeStepNumber === undefined);
        const hasSteps = Boolean(job.steps && job.steps.length > 0);

        return (
          <li key={job.id} role="none">
            <div
              role="treeitem"
              aria-level={1}
              aria-expanded={hasSteps ? isExpanded : undefined}
              aria-selected={isJobActive}
              data-job-id={job.id}
              tabIndex={0}
              className={`ad-tree__row ${isJobActive ? "ad-tree__row--active" : ""}`}
              onClick={() => {
                if (hasSteps) toggleExpand(job.id);
                onSelectJob?.(job.id);
              }}
            >
              {hasSteps ? (
                <Icon
                  name={isExpanded ? "chevron-down" : "chevron-right"}
                  size={12}
                  className="ad-tree__chev"
                />
              ) : (
                <span className="ad-icon ad-icon--12" aria-hidden="true" />
              )}
              <StatusLabel status={job.status} iconOnly still={still} />
              <span className="ad-tree__name" title={job.name}>
                {job.name}
              </span>
              {job.duration ? (
                <span className="ad-caption ad-muted ad-num">{job.duration}</span>
              ) : null}
            </div>

            {hasSteps && isExpanded ? (
              <ul role="group">
                {job.steps!.map((step) => {
                  const isStepActive =
                    step.active ||
                    (activeJobId === job.id && activeStepNumber === step.number);
                  return (
                    <li key={step.number} role="none">
                      <div
                        role="treeitem"
                        aria-level={2}
                        aria-selected={isStepActive}
                        data-job-id={job.id}
                        data-step-number={step.number}
                        tabIndex={0}
                        className={`ad-tree__row ad-tree__row--step ${
                          isStepActive ? "ad-tree__row--active" : ""
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectStep?.(job.id, step.number);
                        }}
                      >
                        <StatusLabel status={step.status} iconOnly still={still} />
                        <span className="ad-tree__name" title={step.name}>
                          {step.name}
                        </span>
                        {step.duration ? (
                          <span className="ad-caption ad-muted ad-num">{step.duration}</span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
