import { describe, expect, it } from "vitest";
import { parseSupportedGitHubRunUrl } from "../../src/domain/services/external-links";

describe("supported external links", () => {
  it("accepts only canonical HTTPS GitHub Actions run URLs", () => {
    expect(parseSupportedGitHubRunUrl("https://github.com/acme/demo/actions/runs/55")?.hostname).toBe("github.com");
    for (const value of [
      "http://github.com/acme/demo/actions/runs/55",
      "https://github.com.evil.example/acme/demo/actions/runs/55",
      "https://user:pass@github.com/acme/demo/actions/runs/55",
      "https://github.com/acme/demo/actions/runs/55?next=https://evil.example",
      "https://github.com/acme/demo",
    ]) expect(parseSupportedGitHubRunUrl(value)).toBeUndefined();
  });
});
