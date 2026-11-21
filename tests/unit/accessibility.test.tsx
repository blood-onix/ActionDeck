// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusLabel } from "../../webview/src/components/StatusLabel";
import { AvailabilityBadge } from "../../webview/src/components/AvailabilityBadge";
import { StateNotice } from "../../webview/src/components/StateNotice";
import {
  STATUS_DESCRIPTORS,
  normalizeStatus,
  mapWorkflowAvailability,
  type Status,
  type Availability,
} from "../../webview/src/utils/status";

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const linear = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Accessibility & non-color status labels", () => {
  it("meets WCAG AA contrast across dark, light, and high-contrast token sets", () => {
    const tokensJson = JSON.parse(
      readFileSync(join(process.cwd(), "tests", "fixtures", "design-tokens.json"), "utf8"),
    ) as { color: { tokens: Array<{ name: string; value: string | Record<string, string> }> } };
    const byName = new Map<string, Record<string, string>>();
    for (const token of tokensJson.color.tokens) {
      if (typeof token.value === "object") {
        byName.set(token.name, token.value);
      }
    }

    const textPairs: Array<[string, string]> = [
      ["ink", "surface"],
      ["ink", "surface-sunken"],
      ["ink", "surface-raised"],
      ["ink", "selection"],
      ["ink-muted", "surface"],
      ["ink-muted", "surface-sunken"],
      ["ink-muted", "surface-raised"],
      ["on-accent", "accent"],
      ["badge-ink", "badge"],
      ["ink", "warning-surface"],
      ["ink", "error-surface"],
      ["ink", "info-surface"],
      ["link", "surface"],
      ["link", "surface-raised"],
    ];

    const iconPairs: Array<[string, string]> = [
      ["focus", "surface"],
      ["focus", "surface-sunken"],
      ["focus", "surface-raised"],
      ["success", "surface"],
      ["failure", "surface"],
      ["warning", "surface"],
      ["running", "surface"],
      ["restricted", "surface"],
      ["uncertain", "surface"],
    ];

    for (const theme of ["dark", "light", "hc"]) {
      for (const [fg, bg] of textPairs) {
        const ratio = contrastRatio(byName.get(fg)![theme]!, byName.get(bg)![theme]!);
        expect(ratio, `${theme} text ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const [fg, bg] of iconPairs) {
        const ratio = contrastRatio(byName.get(fg)![theme]!, byName.get(bg)![theme]!);
        expect(ratio, `${theme} icon ${fg} on ${bg}`).toBeGreaterThanOrEqual(3.0);
      }
    }
  });

  it("maps all 15 statuses to 15 unique Codicons and Title Case labels", () => {
    const allStatuses: Status[] = [
      "success",
      "failure",
      "cancelled",
      "running",
      "queued",
      "waiting_approval",
      "skipped",
      "restricted",
      "outcome_uncertain",
      "stale",
      "not_loaded",
      "paused",
      "scheduled",
      "missed_schedule",
      "blocked",
    ];
    const codicons = new Set<string>();
    const labels = new Set<string>();

    for (const status of allStatuses) {
      const desc = STATUS_DESCRIPTORS[status];
      codicons.add(desc.codicon);
      labels.add(desc.label);

      const { container, unmount } = render(<StatusLabel status={status} />);
      expect(screen.getByText(desc.label)).toBeTruthy();
      const iconEl = container.querySelector(`.codicon-${desc.codicon}`);
      expect(iconEl).toBeTruthy();
      expect(iconEl?.className).toContain(`ad-tone-${desc.tone}`);
      if (status === "running") {
        expect(iconEl?.className).toContain("ad-spin");
      } else {
        expect(iconEl?.className).not.toContain("ad-spin");
      }
      unmount();
    }

    expect(codicons.size).toBe(15);
    expect(labels.size).toBe(15);
  });

  it("keeps waiting_approval distinct from success and completed states", () => {
    const waiting = STATUS_DESCRIPTORS.waiting_approval;
    const success = STATUS_DESCRIPTORS.success;
    expect(waiting.codicon).toBe("watch");
    expect(waiting.tone).toBe("warning");
    expect(waiting.label).toBe("Waiting for Approval");
    expect(waiting.codicon).not.toBe(success.codicon);
    expect(waiting.tone).not.toBe(success.tone);
    expect(waiting.label).not.toBe(success.label);
  });

  it("supports iconOnly with title + aria-label, still=true, and unknown string fallback", () => {
    const { container, unmount } = render(<StatusLabel status="running" iconOnly still />);
    const root = container.querySelector("[aria-label='Running']");
    expect(root).toBeTruthy();
    expect(root?.getAttribute("title")).toBe("Running");
    expect(container.querySelector(".ad-spin")).toBeNull();
    unmount();

    expect(normalizeStatus("unexpected_raw_value")).toBe("outcome_uncertain");
    expect(normalizeStatus(null)).toBe("outcome_uncertain");
    // Dashboard rows combine status and conclusion in one string.
    expect(normalizeStatus("completed / success")).toBe("success");
    expect(normalizeStatus("completed / failure")).toBe("failure");
    expect(normalizeStatus("completed / cancelled")).toBe("cancelled");
    expect(normalizeStatus("completed / mystery")).toBe("outcome_uncertain");
    const { unmount: unmountCombined } = render(<StatusLabel status="completed / success" />);
    expect(screen.getByText("Success")).toBeTruthy();
    unmountCombined();
    const { unmount: unmountUnknown } = render(<StatusLabel status="unexpected_raw_value" />);
    expect(screen.getByText("Outcome Uncertain")).toBeTruthy();
    unmountUnknown();
  });

  it("renders all 7 workflow availability chips with neutral vs alert tones", () => {
    const availabilities: Availability[] = [
      "synced",
      "remote_only",
      "local_only",
      "disabled",
      "invalid_yaml",
      "never_run",
      "access_restricted",
    ];
    for (const value of availabilities) {
      const desc = mapWorkflowAvailability(value);
      const { container, unmount } = render(<AvailabilityBadge value={value} />);
      expect(screen.getByText(desc.label)).toBeTruthy();
      const iconEl = container.querySelector(`.codicon-${desc.codicon}`);
      expect(iconEl).toBeTruthy();
      if (value === "invalid_yaml") {
        expect(desc.alert).toBe(true);
        expect(iconEl?.className).toContain("ad-tone-failure");
      } else if (value === "access_restricted") {
        expect(desc.alert).toBe(true);
        expect(iconEl?.className).toContain("ad-tone-restricted");
      } else {
        expect(desc.alert).toBe(false);
        expect(iconEl?.className).toContain("ad-tone-muted");
      }
      unmount();
    }
    expect(mapWorkflowAvailability("local_only").disableTriggerReason).toBe("Push this workflow to run it");
  });

  it("renders all 9 DataState variants with distinct icons and structures", () => {
    // 1. not_loaded: Load button and zero skeleton bars
    const { container: c1, unmount: u1 } = render(
      <StateNotice
        kind="not_loaded"
        detail="Run history loads on demand."
        action={<button type="button">Load</button>}
      />,
    );
    expect(c1.querySelector(".ad-skel")).toBeNull();
    expect(screen.getByRole("button", { name: "Load" })).toBeTruthy();
    expect(c1.querySelector(".codicon-circle-small")).toBeTruthy();
    u1();

    // 2. loading: static .ad-skel bars + .ad-sr text
    const { container: c2, unmount: u2 } = render(
      <StateNotice kind="loading" title="Loading workflows…" />,
    );
    expect(c2.querySelectorAll(".ad-skel").length).toBeGreaterThanOrEqual(3);
    expect(c2.querySelector(".ad-sr")?.textContent).toContain("Loading workflows");
    u2();

    // 3. empty: explicit zero
    const { container: c3, unmount: u3 } = render(
      <StateNotice kind="empty" title="No self-hosted runners registered (0 items)" />,
    );
    expect(c3.querySelector(".codicon-inbox")).toBeTruthy();
    expect(screen.getByText(/0 items/)).toBeTruthy();
    u3();

    // 4. stale: warning-surface + timestamp/retry
    const { container: c4, unmount: u4 } = render(
      <StateNotice
        kind="stale"
        title="Showing stale data"
        detail="Fetched 5 min ago. Retry after 15:10."
      />,
    );
    expect(c4.querySelector(".ad-notice--stale")).toBeTruthy();
    expect(c4.querySelector(".codicon-warning")).toBeTruthy();
    u4();

    // 5. restricted
    const { container: c5, unmount: u5 } = render(
      <StateNotice kind="restricted" detail="Actions read access is required." />,
    );
    expect(c5.querySelector(".codicon-lock")).toBeTruthy();
    u5();

    // 6. sso
    const { container: c6, unmount: u6 } = render(
      <StateNotice kind="sso" detail="Authorize SSO to continue." />,
    );
    expect(c6.querySelector(".codicon-shield")).toBeTruthy();
    u6();

    // 7. expired
    const { container: c7, unmount: u7 } = render(
      <StateNotice kind="expired" detail="Retention period elapsed." />,
    );
    expect(c7.querySelector(".codicon-history")).toBeTruthy();
    u7();

    // 8. in_progress
    const { container: c8, unmount: u8 } = render(
      <StateNotice kind="in_progress" detail="Logs are still being produced." />,
    );
    expect(c8.querySelector(".codicon-sync")).toBeTruthy();
    u8();

    // 9. uncertain: dashed border + Find run
    const { container: c9, unmount: u9 } = render(
      <StateNotice
        kind="uncertain"
        detail="Run could not be matched."
        action={<button type="button">Find run</button>}
      />,
    );
    expect(c9.querySelector(".ad-notice--uncertain")).toBeTruthy();
    expect(c9.querySelector(".codicon-question")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find run" })).toBeTruthy();
    u9();
  });
});
