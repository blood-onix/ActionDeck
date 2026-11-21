import React from "react";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { StateNotice } from "./StateNotice";

export type SettingsCardState =
  | "loaded"
  | "empty"
  | "not_loaded"
  | "restricted"
  | "sso"
  | "rate_limited";

export interface SettingsCardItem {
  name: string;
  meta: string;
}

export interface SettingsCardGroup {
  label: string;
  items: readonly SettingsCardItem[];
}

export interface SettingsCardProps {
  title: string;
  icon?: string | undefined;
  state?: SettingsCardState | undefined;
  items?: readonly SettingsCardItem[] | undefined;
  /** Optional scope groups (e.g. Repository, each environment); rendered instead of `items` when set. */
  groups?: readonly SettingsCardGroup[] | undefined;
  /** Age caption, e.g. "updated 3m ago" or "polled just now". */
  polled?: string | undefined;
  note?: string | undefined;
  emptyText?: string | undefined;
  detailText?: string | undefined;
  loading?: boolean | undefined;
  onLoad?: (() => void) | undefined;
  children?: React.ReactNode;
}

function ItemList({ items }: { items: readonly SettingsCardItem[] }): React.JSX.Element {
  return (
    <ul className="ad-kv">
      {items.map((item, index) => (
        <li key={`${item.name}:${index}`}>
          <span className="ad-kv__name ad-mono-sm" title={item.name}>{item.name}</span>
          {item.meta ? (
            <span className="ad-kv__meta ad-caption ad-muted" title={item.meta}>{item.meta}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function SettingsCard({
  title,
  icon = "settings-gear",
  state = "not_loaded",
  items = [],
  groups,
  polled,
  note,
  emptyText = `No ${title.toLowerCase()} found (0 items)`,
  detailText,
  loading = false,
  onLoad,
  children,
}: SettingsCardProps): React.JSX.Element {
  const count = groups ? groups.reduce((total, group) => total + group.items.length, 0) : items.length;
  const loadButton = onLoad ? (
    <Button busy={loading} onClick={onLoad} aria-label={`Load ${title}`}>
      Load
    </Button>
  ) : null;

  return (
    <article className="ad-card ad-settings" aria-label={title}>
      <header className="ad-settings__head">
        <Icon name={icon} size={14} tone="muted" />
        <strong>{title}</strong>
        {state === "loaded" ? <span className="ad-badge">{count}</span> : null}
        <span className="ad-toolbar__spacer" />
        {polled ? <span className="ad-caption ad-muted">{polled}</span> : null}
        {onLoad && state !== "not_loaded" ? (
          <Button variant="ghost" icon="refresh" title={`Refresh ${title}`} busy={loading} onClick={onLoad} />
        ) : null}
      </header>

      {note ? (
        <div className="ad-settings__note ad-caption ad-muted">
          <Icon name="key" size={12} tone="muted" />
          <span>{note}</span>
        </div>
      ) : null}

      {state === "not_loaded" ? (
        <StateNotice
          kind="not_loaded"
          detail={detailText ?? `${title} load on demand.`}
          action={loadButton}
          inline
        />
      ) : null}

      {state === "empty" ? (
        <StateNotice kind="empty" title={emptyText} detail={detailText} inline />
      ) : null}

      {state === "restricted" ? <StateNotice kind="restricted" detail={detailText} inline /> : null}
      {state === "sso" ? <StateNotice kind="sso" detail={detailText} inline /> : null}
      {state === "rate_limited" ? <StateNotice kind="rate_limited" detail={detailText} inline /> : null}

      {state === "loaded" && groups
        ? groups.map((group) => (
            <section key={group.label} className="ad-settings__group" aria-label={group.label}>
              <h4 className="ad-section">{group.label}</h4>
              <ItemList items={group.items} />
            </section>
          ))
        : null}

      {state === "loaded" && !groups && items.length > 0 ? <ItemList items={items} /> : null}

      {children}
    </article>
  );
}
