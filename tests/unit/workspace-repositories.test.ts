import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: {
    isTrusted: true,
    workspaceFolders: [] as Array<{ uri: { toString(): string }; name: string }>,
  },
  getExtension: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: mocks.workspace,
  extensions: { getExtension: mocks.getExtension },
  window: {
    showQuickPick: mocks.showQuickPick,
    showWarningMessage: mocks.showWarningMessage,
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
  },
  commands: { executeCommand: mocks.executeCommand },
}));

import { chooseRepository } from "../../src/host/providers/workspace-repositories";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.isTrusted = true;
  mocks.workspace.workspaceFolders = [];
});

describe("workspace repository selection", () => {
  it("does not inspect Git remotes in an untrusted workspace", async () => {
    mocks.workspace.isTrusted = false;
    await expect(chooseRepository()).resolves.toBeUndefined();
    expect(mocks.showWarningMessage).toHaveBeenCalledOnce();
    expect(mocks.getExtension).not.toHaveBeenCalled();
  });

  it("presents every matching folder/remote and returns only the explicit choice", async () => {
    const firstFolder = { uri: { toString: () => "file:///one" }, name: "one" };
    const secondFolder = { uri: { toString: () => "file:///two" }, name: "two" };
    mocks.workspace.workspaceFolders = [firstFolder, secondFolder];
    mocks.getExtension.mockReturnValue({
      exports: {
        getAPI: () => ({
          repositories: [
            {
              rootUri: firstFolder.uri,
              state: { remotes: [{ name: "origin", fetchUrl: "https://github.com/acme/one.git", pushUrl: "" }] },
            },
            {
              rootUri: secondFolder.uri,
              state: {
                remotes: [
                  { name: "upstream", fetchUrl: "https://github.com/acme/two.git", pushUrl: "" },
                  { name: "enterprise", fetchUrl: "https://github.example.com/acme/two.git", pushUrl: "" },
                ],
              },
            },
          ],
        }),
      },
    });
    mocks.showQuickPick.mockResolvedValue({ choiceIndex: 1 });

    await expect(chooseRepository()).resolves.toEqual({
      folder: secondFolder,
      remoteName: "upstream",
      owner: "acme",
      repo: "two",
    });
    expect(mocks.showQuickPick).toHaveBeenCalledWith([
      { label: "acme/one", description: "one · origin", choiceIndex: 0 },
      { label: "acme/two", description: "two · upstream", choiceIndex: 1 },
    ], expect.objectContaining({ canPickMany: false }));
  });
});
