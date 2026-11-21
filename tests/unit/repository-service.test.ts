import { describe, expect, it } from "vitest";
import { createRepositoryContext, resolveGitHubRemote } from "../../src/application/repositories/repository-service";

describe("Git remote resolution", () => {
  it("supports HTTPS, SSH URI, and SCP-style GitHub remotes", () => {
    const result = resolveGitHubRemote([
      { name: "origin", fetchUrl: "https://github.com/Owner/Repo.git", pushUrl: "" },
      { name: "upstream", fetchUrl: "ssh://git@github.com/team/tool.git", pushUrl: "" },
      { name: "fork", fetchUrl: "git@github.com:someone/fork.git", pushUrl: "" },
    ]);
    expect(result.map(({ owner, repo }) => `${owner}/${repo}`)).toEqual(["Owner/Repo", "team/tool", "someone/fork"]);
  });

  it("does not treat GitHub Enterprise or unrelated hosts as GitHub.com", () => {
    expect(resolveGitHubRemote([
      { name: "origin", fetchUrl: "https://github.example.com/acme/demo.git", pushUrl: "" },
      { name: "other", fetchUrl: "https://example.com/acme/demo.git", pushUrl: "" },
    ])).toEqual([]);
  });

  it("requires an explicit workspace and remote and binds identity to both", () => {
    expect(() => createRepositoryContext("/workspace", "", "acme", "demo")).toThrow(
      "A workspace folder, Git remote, owner, and repository must be selected.",
    );
    const origin = createRepositoryContext("file:///workspace", "origin", "acme", "demo");
    const upstream = createRepositoryContext("file:///workspace", "upstream", "acme", "demo");
    const otherFolder = createRepositoryContext("file:///other", "origin", "acme", "demo");
    expect(origin.id).not.toBe(upstream.id);
    expect(origin.id).not.toBe(otherFolder.id);
    expect(origin).not.toHaveProperty("token");
  });
});
