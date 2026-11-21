import React, { useEffect, useId, useState } from "react";
import type { Bridge } from "../bridge";
import { Button } from "./Button";

interface BranchListResponse {
  names: string[];
  truncated: boolean;
  cachedAt: number;
  current?: string;
}

const PINNED_BRANCHES = ["main", "master"];

/** main/master first, then the checked-out branch, then the rest in host order. */
export function orderBranches(names: readonly string[], current?: string): string[] {
  const pinned = PINNED_BRANCHES.filter((name) => names.includes(name));
  if (current && names.includes(current) && !pinned.includes(current)) pinned.push(current);
  return [...pinned, ...names.filter((name) => !pinned.includes(name))];
}

export interface RemoteBranches {
  readonly names: readonly string[];
  readonly truncated: boolean;
  /** Branch checked out in the workspace, when it exists on the remote. */
  readonly current?: string;
  /** True once the first load finished, successfully or not. */
  readonly settled: boolean;
  readonly loading: boolean;
  readonly error: string;
  refresh(): void;
}

/** Remote branches for dispatch refs. The host caches them, so every form can ask on open. */
export function useRemoteBranches(bridge: Bridge, enabled = true): RemoteBranches {
  const [names, setNames] = useState<readonly string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [current, setCurrent] = useState<string>();
  const [settled, setSettled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(refresh: boolean) {
    setLoading(true);
    setError("");
    try {
      const response = await bridge.request<BranchListResponse>("repository.branches", refresh ? { refresh: true } : {});
      const current = typeof response?.current === "string" && response.current ? response.current : undefined;
      setNames(orderBranches(Array.isArray(response?.names) ? response.names : [], current));
      setTruncated(Boolean(response?.truncated));
      setCurrent(current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      setSettled(true);
    }
  }

  useEffect(() => {
    if (enabled) void load(false);
  }, [bridge, enabled]);

  return { names, truncated, ...(current ? { current } : {}), settled, loading, error, refresh: () => void load(true) };
}

/**
 * A ref field that suggests remote branches but accepts any typed branch, tag or SHA.
 * `onCommit` fires when a listed branch is picked or the field loses focus.
 */
export function BranchRefInput({
  id,
  value,
  branches,
  disabled = false,
  ariaLabel,
  onChange,
  onCommit,
}: {
  id?: string;
  value: string;
  branches: RemoteBranches;
  disabled?: boolean;
  ariaLabel: string;
  onChange(value: string): void;
  onCommit?(value: string): void;
}): React.JSX.Element {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Native <datalist> filters by the current value, hiding every branch but the prefilled one.
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(-1);
  const needle = filter.trim().toLowerCase();
  const options = needle ? branches.names.filter((name) => name.toLowerCase().includes(needle)) : branches.names;
  const known = branches.names.includes(value.trim());
  const hint = branches.error
    ? `Could not load branches (${branches.error}). Type a branch, tag or SHA.`
    : branches.loading && branches.names.length === 0
      ? "Loading remote branches…"
      : value.trim() !== "" && !known
        ? "Not a listed branch: it is used as typed (tag, SHA or another ref)."
        : `${branches.names.length}${branches.truncated ? "+" : ""} remote branches. Pick one or type any ref.`;

  function openList() {
    setFilter("");
    setActive(-1);
    setOpen(true);
  }

  function choose(name: string) {
    onChange(name);
    onCommit?.(name);
    setOpen(false);
  }

  return (
    <div className="ad-refinput">
      <div className="ad-refinput__row">
        <div className="ad-refinput__field">
          <input
            id={id}
            className="ad-input"
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            onFocus={openList}
            onClick={() => { if (!open) openList(); }}
            onChange={(event) => {
              const next = event.target.value;
              onChange(next);
              setFilter(next);
              setActive(-1);
              setOpen(true);
              if (branches.names.includes(next)) onCommit?.(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (!open) openList();
                else setActive((index) => Math.min(index + 1, options.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter" && open && active >= 0 && options[active]) {
                event.preventDefault();
                choose(options[active]);
              } else if (event.key === "Escape" && open) {
                event.preventDefault();
                setOpen(false);
              }
            }}
            onBlur={(event) => {
              setOpen(false);
              onCommit?.(event.target.value.trim());
            }}
          />
          {open && options.length > 0 && (
            <ul id={listId} className="ad-refinput__list" role="listbox" aria-label={`${ariaLabel} suggestions`}>
              {options.map((name, index) => (
                <li
                  key={name}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "is-active" : undefined}
                  // mousedown keeps focus in the input so blur doesn't close the list before the pick.
                  onMouseDown={(event) => { event.preventDefault(); choose(name); }}
                  onMouseEnter={() => setActive(index)}
                >
                  {name}
                  {name === branches.current && <span className="ad-refinput__tag">current</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          variant="ghost"
          icon="refresh"
          title="Reload remote branches"
          aria-label="Reload remote branches"
          busy={branches.loading}
          disabled={disabled}
          onClick={branches.refresh}
        />
      </div>
      <datalist id={listId}>
        {branches.names.map((name) => <option key={name} value={name} />)}
      </datalist>
      <span className="ad-field__help">{hint}</span>
    </div>
  );
}
