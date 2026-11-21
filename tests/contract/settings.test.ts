import { describe, expect, it } from "vitest";
import { settingsLoadCardPayload } from "../../src/protocol/settings";

describe("Settings protocol contract", () => {
  it("validates settings.loadCard for each independent card type", () => {
    expect(settingsLoadCardPayload.safeParse({ card: "environments" }).success).toBe(true);
    expect(settingsLoadCardPayload.safeParse({ card: "variables_and_secrets" }).success).toBe(true);
    expect(settingsLoadCardPayload.safeParse({ card: "runners" }).success).toBe(true);
    expect(settingsLoadCardPayload.safeParse({ card: "unknown" }).success).toBe(false);
  });
});
