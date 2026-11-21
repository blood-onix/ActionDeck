import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { getWebviewState, setWebviewState } from "../bridge";
import { parseLogLines, type AnsiSegment, type LogLine } from "../utils/log-format";

export { parseLogLines };
export type { LogLine };

export type TimestampMode = "time" | "full" | "off";

const TIMESTAMP_MODES: readonly TimestampMode[] = ["time", "full", "off"];
const TIMESTAMP_LABEL: Record<TimestampMode, string> = {
  time: "Timestamps: local time (click for full ISO)",
  full: "Timestamps: full ISO (click to hide)",
  off: "Timestamps: hidden (click to show time)",
};

interface LogViewState {
  logTimestamps?: TimestampMode;
  logWrap?: boolean;
}

export interface LogViewerProps {
  lines: readonly LogLine[];
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  truncated?: string | boolean | undefined;
  canCopy?: boolean | undefined;
  onCopy?: (() => void) | undefined;
  bodyRef?: React.RefObject<HTMLPreElement | null> | undefined;
  onScroll?: ((event: React.UIEvent<HTMLPreElement>) => void) | undefined;
  /** When provided, shows a button that gives the log the whole panel. */
  expanded?: boolean | undefined;
  onToggleExpand?: (() => void) | undefined;
  jumpToError?: boolean | undefined;
}

export function LogViewer({
  lines,
  query: controlledQuery,
  onQueryChange,
  truncated,
  canCopy = true,
  onCopy,
  bodyRef,
  onScroll,
  expanded,
  onToggleExpand,
  jumpToError = false,
}: LogViewerProps): React.JSX.Element {
  const [internalQuery, setInternalQuery] = useState("");
  const [wrap, setWrapState] = useState(() => getWebviewState<LogViewState>().logWrap ?? false);
  const [tsMode, setTsModeState] = useState<TimestampMode>(
    () => getWebviewState<LogViewState>().logTimestamps ?? "time",
  );
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const setWrap = (next: boolean) => {
    setWrapState(next);
    setWebviewState<LogViewState>({ logWrap: next });
  };
  const cycleTimestamps = () => {
    const next = TIMESTAMP_MODES[(TIMESTAMP_MODES.indexOf(tsMode) + 1) % TIMESTAMP_MODES.length]!;
    setTsModeState(next);
    setWebviewState<LogViewState>({ logTimestamps: next });
  };

  const query = controlledQuery !== undefined ? controlledQuery : internalQuery;
  const setQuery = (next: string) => {
    if (onQueryChange) onQueryChange(next);
    else setInternalQuery(next);
  };

  const normalizedQuery = query.trim().toLowerCase();

  const matchIndices = useMemo(() => {
    if (!normalizedQuery) return [];
    const indices: number[] = [];
    lines.forEach((line, index) => {
      if (line.text.toLowerCase().includes(normalizedQuery)) {
        indices.push(index);
      }
    });
    return indices;
  }, [lines, normalizedQuery]);

  const stepIndices = useMemo(() => {
    const indices: number[] = [];
    lines.forEach((line, index) => {
      if (line.kind === "step") indices.push(index);
    });
    return indices;
  }, [lines]);

  // Groups start collapsed (like GitHub), except those that contain an error.
  const defaultOpenGroups = useMemo(() => {
    const open = new Set<number>();
    for (const line of lines) {
      if (line.group !== undefined && line.kind === "error") open.add(line.group);
    }
    return open;
  }, [lines]);
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => setToggledGroups(new Set()), [lines]);

  const groupSizes = useMemo(() => {
    const sizes = new Map<number, number>();
    for (const line of lines) {
      if (line.group !== undefined) sizes.set(line.group, (sizes.get(line.group) ?? 0) + 1);
    }
    return sizes;
  }, [lines]);

  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  const clampedMatchIndex =
    matchIndices.length > 0 ? Math.min(activeMatchIndex, matchIndices.length - 1) : 0;
  const activeMatchLine = matchIndices.length > 0 ? matchIndices[clampedMatchIndex] : undefined;
  const forcedOpenGroup = activeMatchLine !== undefined ? lines[activeMatchLine]?.group : undefined;

  const isGroupOpen = (group: number) =>
    group === forcedOpenGroup || defaultOpenGroups.has(group) !== toggledGroups.has(group);

  const toggleGroup = (group: number) => {
    setToggledGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const allGroups = stepIndices.filter((index) => groupSizes.has(index));
  const anyGroupOpen = allGroups.some(isGroupOpen);
  const setAllGroups = (open: boolean) => {
    setToggledGroups(new Set(allGroups.filter((group) => defaultOpenGroups.has(group) !== open)));
  };

  useEffect(() => {
    if (activeMatchLine === undefined) return;
    const lineEl = bodyRef?.current?.querySelector<HTMLElement>(
      `[data-line-index="${activeMatchLine}"]`,
    );
    lineEl?.scrollIntoView?.({ block: "center" });
  }, [activeMatchLine, bodyRef]);

  const matchesLabel = normalizedQuery
    ? matchIndices.length > 0
      ? `${clampedMatchIndex + 1} of ${matchIndices.length}`
      : "0 matches"
    : undefined;

  const firstErrorIndex = useMemo(() => lines.findIndex((line) => line.kind === "error"), [lines]);

  function jumpToFirstError() {
    if (firstErrorIndex < 0) return;
    const line = bodyRef?.current?.querySelector<HTMLElement>(`[data-line-index="${firstErrorIndex}"]`);
    line?.scrollIntoView?.({ block: "center" });
    line?.focus?.();
  }

  useEffect(() => {
    if (!jumpToError || firstErrorIndex < 0) return;
    const frame = requestAnimationFrame(() => jumpToFirstError());
    return () => cancelAnimationFrame(frame);
  }, [jumpToError, firstErrorIndex, lines]);

  function jumpStep(delta: -1 | 1) {
    if (stepIndices.length === 0) return;
    const next = (activeStepIndex + delta + stepIndices.length) % stepIndices.length;
    setActiveStepIndex(next);
    const lineEl = bodyRef?.current?.querySelector<HTMLElement>(
      `[data-line-index="${stepIndices[next]}"]`,
    );
    lineEl?.scrollIntoView?.({ block: "nearest" });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }
    if (
      !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    ) {
      if (event.key === "[") {
        event.preventDefault();
        jumpStep(-1);
      } else if (event.key === "]") {
        event.preventDefault();
        jumpStep(1);
      }
    }
  }

  function handleCopy() {
    if (onCopy) {
      onCopy();
    } else {
      const fullText = lines.map((l) => l.raw ?? l.text).join("\n");
      void navigator.clipboard?.writeText(fullText);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const truncationText =
    typeof truncated === "string"
      ? truncated
      : truncated
        ? "Excerpt truncated at the 10,000-line / 2 MiB safe display limit."
        : undefined;

  const hasTimestamps = lines.some((line) => line.time);
  const showTs = hasTimestamps && tsMode !== "off";
  const lastLineNumber = lines.length > 0 ? (lines[lines.length - 1]!.n ?? lines.length) : 1;
  const bodyStyle = {
    "--ad-log-n-width": `${String(lastLineNumber).length}ch`,
  } as React.CSSProperties;

  let previousClock: string | undefined;

  return (
    <div className="ad-log" onKeyDown={handleKeyDown}>
      <div className="ad-log__bar">
        <label className="ad-search ad-search--sm">
          <Icon name="search" size={14} tone="muted" />
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search job log"
            placeholder="Search log…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                searchInputRef.current?.blur();
              } else if (event.key === "Enter" && matchIndices.length > 0) {
                event.preventDefault();
                const delta = event.shiftKey ? matchIndices.length - 1 : 1;
                setActiveMatchIndex((prev) => (prev + delta) % matchIndices.length);
              }
            }}
          />
          <kbd className="ad-kbd" aria-hidden="true">Ctrl+F</kbd>
        </label>

        {matchesLabel ? (
          <span className="ad-caption ad-muted ad-num" role="status">
            {matchesLabel}
          </span>
        ) : null}

        <span className="ad-toolbar__spacer" />

        {jumpToError ? (
          <Button
            variant="ghost"
            icon="arrow-down"
            title="Jump to error"
            disabled={firstErrorIndex < 0}
            onClick={jumpToFirstError}
          >
            Jump to error
          </Button>
        ) : null}
        <Button
          variant="ghost"
          icon="chevron-up"
          title="Previous step ([)"
          kbd="["
          disabled={stepIndices.length === 0}
          onClick={() => jumpStep(-1)}
        />
        <Button
          variant="ghost"
          icon="chevron-down"
          title="Next step (])"
          kbd="]"
          disabled={stepIndices.length === 0}
          onClick={() => jumpStep(1)}
        />
        {allGroups.length > 0 ? (
          <Button
            variant="ghost"
            icon={anyGroupOpen ? "fold" : "unfold"}
            title={anyGroupOpen ? "Collapse all groups" : "Expand all groups"}
            onClick={() => setAllGroups(!anyGroupOpen)}
          />
        ) : null}
        {hasTimestamps ? (
          <Button
            variant="ghost"
            icon="watch"
            title={TIMESTAMP_LABEL[tsMode]}
            pressed={tsMode !== "off"}
            onClick={cycleTimestamps}
          />
        ) : null}
        <Button
          variant="ghost"
          icon="word-wrap"
          title="Toggle word wrap"
          pressed={wrap}
          onClick={() => setWrap(!wrap)}
        />
        {onToggleExpand ? (
          <Button
            variant="ghost"
            icon={expanded ? "screen-normal" : "screen-full"}
            title={expanded ? "Show jobs and steps" : "Expand log"}
            pressed={Boolean(expanded)}
            onClick={onToggleExpand}
          />
        ) : null}
        <Button
          variant="ghost"
          icon={copied ? "check" : "copy"}
          title="Copy log"
          disabled={!canCopy || lines.length === 0}
          onClick={handleCopy}
        >
          {copied ? "Copied" : "Copy log"}
        </Button>
      </div>

      {truncationText ? (
        <div className="ad-log__trunc" role="status">
          <Icon name="warning" size={14} tone="warning" />
          <span>{truncationText}</span>
        </div>
      ) : null}

      <pre
        ref={bodyRef}
        className={`ad-log__body log-text${expanded ? " ad-log__body--expanded" : ""}`}
        role="log"
        aria-label="Job log"
        tabIndex={0}
        onScroll={onScroll}
        style={bodyStyle}
      >
        {lines.map((line, index) => {
          if (line.group !== undefined && !isGroupOpen(line.group)) return null;

          const isHeader = line.kind === "step" && groupSizes.has(index);
          const open = isHeader && isGroupOpen(index);
          const lineClasses = [
            "ad-log__line",
            wrap ? "ad-log__line--wrap" : "",
            line.kind ? `ad-log__line--${line.kind}` : "",
            line.group !== undefined ? "ad-log__line--in-group" : "",
            index === activeMatchLine ? "ad-log__line--match" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const clock = tsMode === "full" ? line.time : line.clock;
          const repeated = tsMode === "time" && clock !== undefined && clock === previousClock;
          if (clock !== undefined) previousClock = clock;

          return (
            <div key={index} className={lineClasses} data-line-index={index} tabIndex={line.kind === "error" ? -1 : undefined}>
              <span className="ad-log__n ad-num">{line.n ?? index + 1}</span>
              {showTs ? (
                <span
                  className={`ad-log__ts ad-num${tsMode === "full" ? " ad-log__ts--full" : ""}${repeated ? " ad-log__ts--repeat" : ""}`}
                  title={line.time}
                >
                  {clock ?? ""}
                </span>
              ) : null}
              {isHeader ? (
                <button
                  type="button"
                  className="ad-log__fold"
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${line.text}`}
                  onClick={() => toggleGroup(index)}
                >
                  <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                </button>
              ) : null}
              <span className="ad-log__t">
                {normalizedQuery && line.text.toLowerCase().includes(normalizedQuery)
                  ? highlightQuery(line.text, normalizedQuery)
                  : line.segments
                    ? renderSegments(line.segments)
                    : line.text}
                {isHeader && !open ? (
                  <span className="ad-log__fold-count">{` ${groupSizes.get(index)} lines`}</span>
                ) : null}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function renderSegments(segments: readonly AnsiSegment[]): React.ReactNode {
  return segments.map((segment, index) =>
    segment.fg || segment.bold ? (
      <span
        key={index}
        className={[segment.fg ? `ad-ansi-${segment.fg}` : "", segment.bold ? "ad-ansi-bold" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {segment.text}
      </span>
    ) : (
      <React.Fragment key={index}>{segment.text}</React.Fragment>
    ),
  );
}

function highlightQuery(text: string, query: string): React.ReactNode {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
