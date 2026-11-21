import { describe, expect, it, vi } from "vitest";
import {
  executeConfirmedCopilotAction,
  type CopilotConfirmationPort,
} from "../../src/application/copilot/execution-tools";
import { UiAuthorization } from "../../src/application/dispatch/authorization";

const context = {
  id: "acme/demo|origin|file:///repo",
  owner: "acme",
  repo: "demo",
  remoteName: "origin",
  workspaceFolderUri: "file:///repo",
  authenticatedUserId: "42",
};

describe("Copilot confirmation & parameter binding", () => {
  it("performs zero mutation on decline or parameter change, and executes once on exact confirmation", async () => {
    const mutate = vi.fn().mockResolvedValue({ state: "request_accepted" });
    const declined: CopilotConfirmationPort = {
      confirm: vi.fn().mockResolvedValue({ approved: false }),
    };

    const declineResult = await executeConfirmedCopilotAction(
      context,
      {
        action: "dispatch_workflow",
        repositoryId: context.id,
        targetLabel: ".github/workflows/deploy.yml",
        refOrEnvironment: "main",
        effectiveParameters: { env: "staging" },
      },
      declined,
      mutate,
    );
    expect(declineResult.executed).toBe(false);
    expect(mutate).not.toHaveBeenCalled();

    const approved: CopilotConfirmationPort = {
      confirm: vi.fn().mockResolvedValue({ approved: true }),
    };
    const okResult = await executeConfirmedCopilotAction(
      context,
      {
        action: "dispatch_workflow",
        repositoryId: context.id,
        targetLabel: ".github/workflows/deploy.yml",
        refOrEnvironment: "main",
        effectiveParameters: { env: "staging" },
      },
      approved,
      mutate,
    );
    expect(okResult.executed).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("cannot reuse UI authorization tokens for Copilot execution", async () => {
    const uiAuth = new UiAuthorization();
    uiAuth.authorize({
      repositoryId: context.id,
      target: "workflow:7",
      ref: "main",
      inputs: { env: "staging" },
    });

    const mutate = vi.fn().mockResolvedValue({ state: "request_accepted" });
    const confirmation: CopilotConfirmationPort = {
      confirm: vi.fn().mockResolvedValue({ approved: false }),
    };

    const result = await executeConfirmedCopilotAction(
      context,
      {
        action: "dispatch_workflow",
        repositoryId: context.id,
        targetLabel: "workflow:7",
        refOrEnvironment: "main",
        effectiveParameters: { env: "staging" },
      },
      confirmation,
      mutate,
    );
    expect(result.executed).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });
});
