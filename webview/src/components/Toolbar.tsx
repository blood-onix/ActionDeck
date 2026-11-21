import React from "react";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { ToggleChip } from "./ToggleChip";

export interface ToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null> | undefined;
  status: string;
  onStatusChange: (value: string) => void;
  statusOptions: readonly string[];
  myRunsOnly: boolean;
  onMyRunsOnlyToggle: () => void;
  selectedCount: number;
  updated?: string | undefined;
  repositoryLabel?: string | undefined;
  refreshing?: boolean | undefined;
  onRefresh: () => void;
  onRunSelected: () => void;
  onOpenReleasePlan: () => void;
  onGroupSelected?: (() => void) | undefined;
  onOpenColumns?: (() => void) | undefined;
  onOpenActionCenter: () => void;
  onOpenSettings: () => void;
}

export function Toolbar({
  query,
  onQueryChange,
  searchInputRef,
  status,
  onStatusChange,
  statusOptions,
  myRunsOnly,
  onMyRunsOnlyToggle,
  selectedCount,
  updated,
  repositoryLabel,
  refreshing = false,
  onRefresh,
  onRunSelected,
  onOpenReleasePlan,
  onGroupSelected,
  onOpenColumns,
  onOpenActionCenter,
  onOpenSettings,
}: ToolbarProps): React.JSX.Element {
  return (
    <header className="ad-toolbar" role="toolbar" aria-label="Workflows">
      {repositoryLabel ? (
        <span className="ad-mono-sm ad-toolbar__meta ad-toolbar__repo" title={repositoryLabel}>
          <Icon name="repo" size={14} tone="muted" />
          <span className="ad-toolbar__repo-name">{repositoryLabel}</span>
        </span>
      ) : null}

      <label className="ad-search">
        <Icon name="search" size={14} tone="muted" />
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Filter workflows"
          placeholder="Filter workflows, folder, branch, actor…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <kbd className="ad-kbd" aria-hidden="true">/</kbd>
      </label>

      <span className="ad-select">
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => onStatusChange(event.target.value)}
        >
          <option value="all">All states</option>
          {statusOptions.map((value) => (
            <option value={value} key={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={12} />
      </span>

      <ToggleChip pressed={myRunsOnly} icon="person" onClick={onMyRunsOnlyToggle}>
        My runs only
      </ToggleChip>

      <span className="ad-toolbar__spacer" />

      {updated ? (
        <span className="ad-caption ad-muted ad-toolbar__meta">{updated}</span>
      ) : null}

      {selectedCount > 0 ? (
        <>
          <span className="ad-caption ad-muted ad-num ad-toolbar__meta">
            {selectedCount} selected
          </span>
          <Button variant="primary" icon="play" onClick={onRunSelected}>
            {`Run selected (${selectedCount})`}
          </Button>
          <Button variant="secondary" icon="layers" onClick={onOpenReleasePlan}>
            {`New plan… (${selectedCount})`}
          </Button>
          {onGroupSelected ? (
            <Button variant="secondary" icon="folder" onClick={onGroupSelected}>
              {`Group… (${selectedCount})`}
            </Button>
          ) : null}
        </>
      ) : null}

      <Button variant="secondary" icon="bell" onClick={onOpenActionCenter}>
        Action Center
      </Button>
      {onOpenColumns ? (
        <Button variant="ghost" icon="list-selection" title="Columns" onClick={onOpenColumns} />
      ) : null}
      <Button variant="ghost" icon="settings-gear" title="Settings" onClick={onOpenSettings} />
      <Button
        variant="ghost"
        icon="refresh"
        title="Refresh"
        busy={refreshing}
        onClick={onRefresh}
      />
    </header>
  );
}
