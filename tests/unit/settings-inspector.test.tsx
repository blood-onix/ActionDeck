// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { SettingsInspector } from "../../webview/src/dashboard/SettingsInspector";
import type { Bridge } from "../../webview/src/bridge";

describe("SettingsInspector UI", () => {
  afterEach(cleanup);

  it("renders independent cards, unretrievable secret notice, and polling runner timestamp", async () => {
    const request = vi.fn().mockImplementation(async (_op: string, payload: { card: string }) => {
      if (payload.card === "environments") {
        return { card: "environments", state: "empty", refreshedAt: "2026-11-14T10:00:00Z" };
      }
      if (payload.card === "variables_and_secrets") {
        return {
          card: "variables_and_secrets",
          state: "loaded",
          refreshedAt: "2026-11-14T10:00:00Z",
          variables: [{ name: "DEPLOY_REGION", value: "us-east-1", scope: "repository" }],
          secrets: [{ name: "DEPLOY_KEY", updatedAt: "2026-11-01T00:00:00Z", scope: "repository" }],
        };
      }
      return {
        card: "runners",
        state: "permission_restricted",
        reason: "Admin access required to list runners.",
        refreshedAt: "2026-11-14T10:00:00Z",
      };
    });
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;

    render(<SettingsInspector bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: /Load Variables & Secrets/i }));
    await screen.findByText(/DEPLOY_KEY/);
    expect(screen.getByText(/Secret values can never be read/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Load Self-hosted runners/i }));
    await screen.findByText(/Admin access required to list runners/i);
    expect(screen.getByText(/polled /i)).toBeTruthy();
  });

  it("labels scope/environment entries, restrictions, and environment wait timers", async () => {
    const request = vi.fn().mockImplementation(async (_op: string, payload: { card: string }) => {
      if (payload.card === "environments") {
        return {
          card: "environments",
          state: "loaded",
          refreshedAt: "2026-11-14T10:00:00Z",
          environments: [{ id: 1, name: "prod", waitTimer: 30, reviewerCount: 2, branchPolicy: "protected_branches" }],
        };
      }
      return {
        card: "variables_and_secrets",
        state: "loaded",
        refreshedAt: "2026-11-14T10:00:00Z",
        variables: [
          { name: "REGION", value: "eu", scope: "repository" },
          { name: "REGION", value: "us", scope: "environment", environmentName: "prod" },
        ],
        secrets: [{ name: "KEY", updatedAt: "2026-11-01T00:00:00Z", scope: "environment", environmentName: "prod" }],
        restrictions: [{ scope: "environment", resource: "secrets", environmentName: "staging", state: "permission_restricted", reason: "denied" }],
        truncated: true,
      };
    });
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;

    render(<SettingsInspector bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: /Load Environments/i }));
    await screen.findByText("2 reviewers · 30 min wait · protected branches");
    fireEvent.click(screen.getByRole("button", { name: /Load Variables & Secrets/i }));
    await screen.findByText("variable · eu");
    const prod = screen.getByRole("region", { name: "Environment: prod" });
    expect(within(prod).getByText("variable · us")).toBeTruthy();
    expect(within(prod).getByText("KEY")).toBeTruthy();
    expect(screen.getByText(/Environment: staging secrets: no access — denied/)).toBeTruthy();
    expect(screen.getByText(/truncated/i)).toBeTruthy();
  });

  it("shows cards cached by the host without loading them again", async () => {
    const request = vi.fn().mockImplementation(async (operation: string) => {
      if (operation === "settings.cachedCards") {
        return {
          cards: {
            environments: {
              card: "environments",
              state: "loaded",
              refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
              environments: [{ id: 1, name: "qa", reviewerCount: 0, branchPolicy: "all_branches" }],
            },
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;

    render(<SettingsInspector bridge={bridge} />);
    await screen.findByText("no rules");
    expect(screen.getByText("updated 5m ago")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh Environments" })).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
