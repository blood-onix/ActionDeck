import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestSchema } from "../../src/protocol/envelopes";
import { copilotExecutionToolSchemas, copilotReadToolSchemas } from "../../src/protocol/copilot";
import { redactSensitiveText } from "../../src/domain/services/redaction";

describe("Cross-feature acceptance & security invariants", () => {
  it("enforces bounded, allowlisted protocol operations and redacts credentials", () => {
    expect(requestSchema.safeParse({
      version: 1,
      type: "request",
      requestId: "req-1",
      operation: "shell.exec",
      payload: {},
    }).success).toBe(false);

    expect(Object.keys(copilotReadToolSchemas)).toHaveLength(7);
    expect(Object.keys(copilotExecutionToolSchemas)).toHaveLength(4);

    const redacted = redactSensitiveText("Authorization: Bearer ghp_1234567890abcdef1234567890abcdef1234");
    expect(redacted).not.toContain("ghp_1234567890abcdef");
  });

  it("ships Stacked Deck Marketplace icon (128x128), monochrome currentColor glyph, and dark galleryBanner", () => {
    const iconPath = join(process.cwd(), "media", "actiondeck-icon.png");
    expect(existsSync(iconPath)).toBe(true);
    const png = readFileSync(iconPath);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);

    const monoSvg = readFileSync(join(process.cwd(), "media", "01-stacked-deck-mono.svg"), "utf8");
    expect(monoSvg).toContain("currentColor");
    expect(monoSvg.toUpperCase()).not.toContain("#C5C5C5");

    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      icon?: string;
      galleryBanner?: { color?: string; theme?: string };
      contributes?: { viewsContainers?: { activitybar?: Array<{ id: string; icon: string }> } };
    };
    expect(pkg.icon).toBe("media/actiondeck-icon.png");
    expect(pkg.galleryBanner).toEqual({ color: "#12161c", theme: "dark" });
    expect(pkg.contributes?.viewsContainers?.activitybar).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "actiondeck",
          icon: "media/01-stacked-deck-mono.svg",
        }),
      ]),
    );
  });
});
