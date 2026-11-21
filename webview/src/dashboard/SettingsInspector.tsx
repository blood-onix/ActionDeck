import { useEffect, useState } from "react";
import type {
  EnvironmentSummary,
  SettingsCardKind,
  SettingsCardResult,
  SettingsRestriction,
} from "../../../src/domain/models/settings";
import { formatRelativeTime } from "../../../src/domain/services/relative-time";
import type { Bridge } from "../bridge";
import {
  SettingsCard,
  type SettingsCardGroup,
  type SettingsCardItem,
  type SettingsCardState,
} from "../components/SettingsCard";

type CardMap = Partial<Record<SettingsCardKind, SettingsCardResult>>;

const REPOSITORY_GROUP = "Repository";

function scopeLabel(scope: "repository" | "environment", environmentName?: string): string {
  return scope === "environment" ? `Environment: ${environmentName ?? "unknown"}` : REPOSITORY_GROUP;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Compact protection summary, e.g. "2 reviewers · 30 min wait · protected branches", or "no rules". */
export function formatEnvironmentRules(environment: EnvironmentSummary): string {
  const parts: string[] = [];
  if (environment.reviewerCount > 0) parts.push(plural(environment.reviewerCount, "reviewer"));
  if (environment.waitTimer) parts.push(`${environment.waitTimer} min wait`);
  if (environment.branchPolicy === "protected_branches") parts.push("protected branches");
  else if (environment.branchPolicy === "custom_branch_policies") parts.push("selected branches");
  return parts.length > 0 ? parts.join(" · ") : "no rules";
}

const RESTRICTION_LABELS: Record<SettingsRestriction["state"], string> = {
  permission_restricted: "no access",
  auth_or_org_required: "SSO authorization required",
  rate_limited: "rate limited",
  temporarily_unavailable: "temporarily unavailable",
};

function mapResultToCardState(result?: SettingsCardResult): SettingsCardState {
  if (!result) return "not_loaded";
  if (result.state === "loaded") return "loaded";
  if (result.state === "empty") return "empty";
  if (result.state === "permission_restricted") return "restricted";
  if (result.state === "auth_or_org_required") return "sso";
  if (result.state === "rate_limited" || result.state === "temporarily_unavailable") {
    return "rate_limited";
  }
  return "not_loaded";
}

function ageCaption(result: SettingsCardResult | undefined, verb: string): string | undefined {
  if (!result?.refreshedAt) return undefined;
  return `${verb} ${formatRelativeTime(result.refreshedAt) ?? "just now"}`;
}

export function SettingsInspector({ bridge }: { bridge: Bridge }) {
  const [cards, setCards] = useState<CardMap>({});
  const [loading, setLoading] = useState<Partial<Record<SettingsCardKind, boolean>>>({});

  // Show what this repository already loaded (in any tab) without spending API calls.
  useEffect(() => {
    let active = true;
    bridge
      .request<{ cards?: CardMap }>("settings.cachedCards", {})
      .then((response) => {
        if (!active || !response?.cards) return;
        setCards((prev) => ({ ...response.cards, ...prev }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  async function loadCard(card: SettingsCardKind) {
    setLoading((prev) => ({ ...prev, [card]: true }));
    try {
      const result = await bridge.request<SettingsCardResult>("settings.loadCard", { card });
      setCards((prev) => ({ ...prev, [card]: result }));
    } catch (reason) {
      setCards((prev) => ({
        ...prev,
        [card]: {
          card,
          state: "temporarily_unavailable",
          refreshedAt: new Date().toISOString(),
          reason: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [card]: false }));
    }
  }

  const env = cards.environments;
  const vars = cards.variables_and_secrets;
  const runners = cards.runners;

  const envItems: SettingsCardItem[] =
    env?.state === "loaded" && env.card === "environments"
      ? env.environments.map((e) => ({ name: e.name, meta: formatEnvironmentRules(e) }))
      : [];

  let varGroups: SettingsCardGroup[] = [];
  if (vars?.state === "loaded" && vars.card === "variables_and_secrets") {
    const byScope = new Map<string, SettingsCardItem[]>([[REPOSITORY_GROUP, []]]);
    const push = (label: string, item: SettingsCardItem) => {
      const list = byScope.get(label) ?? [];
      list.push(item);
      byScope.set(label, list);
    };
    for (const v of vars.variables ?? []) {
      push(scopeLabel(v.scope, v.environmentName), { name: v.name, meta: v.value ? `variable · ${v.value}` : "variable" });
    }
    for (const s of vars.secrets ?? []) {
      const updated = formatRelativeTime(s.updatedAt);
      push(scopeLabel(s.scope, s.environmentName), { name: s.name, meta: updated ? `secret · updated ${updated}` : "secret" });
    }
    varGroups = [...byScope].filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }));
  }

  const runnerItems: SettingsCardItem[] =
    runners?.state === "loaded" && runners.card === "runners"
      ? runners.runners.map((r) => ({
          name: r.name,
          meta: [r.os, r.online ? (r.busy ? "busy" : "idle") : "offline", ...r.labels].join(" · "),
        }))
      : [];

  return (
    <section aria-label="Repository Actions Settings Inspector" className="settings-inspector">
      <SettingsCard
        title="Environments"
        icon="globe"
        state={mapResultToCardState(env)}
        items={envItems}
        polled={ageCaption(env, "updated")}
        detailText={env && env.state !== "loaded" ? env.reason : undefined}
        loading={Boolean(loading.environments)}
        onLoad={() => void loadCard("environments")}
      />

      <SettingsCard
        title="Variables & secrets"
        icon="key"
        state={mapResultToCardState(vars)}
        groups={varGroups}
        polled={ageCaption(vars, "updated")}
        detailText={vars && vars.state !== "loaded" ? vars.reason : undefined}
        note="Secret values can never be read. Names and dates only."
        loading={Boolean(loading.variables_and_secrets)}
        onLoad={() => void loadCard("variables_and_secrets")}
      >
        {vars?.state === "loaded" && vars.card === "variables_and_secrets" ? (
          <>
            {vars.restrictions?.map((r) => (
              <p
                className="ad-caption ad-muted"
                key={`${r.scope}:${r.environmentName ?? ""}:${r.resource}`}
              >
                {`${scopeLabel(r.scope, r.environmentName)} ${r.resource}: ${RESTRICTION_LABELS[r.state]}${r.reason ? ` — ${r.reason}` : ""}`}
              </p>
            ))}
            {vars.truncated ? (
              <p className="ad-caption ad-muted">
                Results were truncated to a bounded number of pages and environments.
              </p>
            ) : null}
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard
        title="Self-hosted runners"
        icon="server"
        state={mapResultToCardState(runners)}
        items={runnerItems}
        polled={ageCaption(runners, "polled")}
        detailText={runners && runners.state !== "loaded" ? runners.reason : undefined}
        loading={Boolean(loading.runners)}
        onLoad={() => void loadCard("runners")}
      />
    </section>
  );
}
