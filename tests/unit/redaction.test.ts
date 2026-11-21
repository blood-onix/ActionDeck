import { describe, expect, it } from "vitest";
import { boundLogExcerpt, MAX_LOG_BYTES, MAX_LOG_LINES } from "../../src/domain/services/log-bounds";
import { redactSensitiveText } from "../../src/domain/services/redaction";

describe("sensitive log redaction", () => {
  it("redacts common environment, quoted, and bearer-token assignments", () => {
    const text = redactSensitiveText([
      "GITHUB_TOKEN=ghp_example",
      "Authorization: Bearer bearer-example",
      '{"client_secret":"quoted example"}',
      "PRIVATE_KEY='multiline key value'",
    ].join("\n"));
    expect(text).not.toMatch(/ghp_example|bearer-example|quoted example|multiline key value/);
    expect(text.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("keeps the final redacted excerpt within byte and line bounds", () => {
    const excerpt = boundLogExcerpt(
      7,
      2,
      `PASSWORD=${"p".repeat(MAX_LOG_BYTES + 100)}\n${"line\n".repeat(MAX_LOG_LINES + 1)}`,
      "2026-01-01T00:00:00Z",
    );
    expect(new TextEncoder().encode(excerpt.text).byteLength).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(excerpt.text.split("\n").length).toBeLessThanOrEqual(MAX_LOG_LINES);
    expect(excerpt.text).not.toContain("p".repeat(100));
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.retrievedAt).toBe("2026-01-01T00:00:00Z");
  });
});
