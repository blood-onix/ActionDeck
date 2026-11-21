import { describe, expect, it } from "vitest";
import { selectPreferredModel, type ChatModelInfo } from "../../src/application/copilot/model-selection";

const model = (id: string, family: string, name: string, vendor = "copilot"): ChatModelInfo => ({ id, family, name, vendor });

const opus = model("claude-opus-5.5", "claude-opus-5.5", "Claude Opus 5.5");
const haiku = model("claude-haiku-5.5", "claude-haiku-5.5", "Claude Haiku 5.5");
const gpt = model("gpt-4.1", "gpt-4.1", "GPT-4.1");
const auto = model("auto", "auto", "Auto");
const other = model("local-llm", "llama", "Local Llama", "ollama");

describe("selectPreferredModel", () => {
  it("returns undefined when no models are available", () => {
    expect(selectPreferredModel([], "auto")).toBeUndefined();
  });

  it("prefers the Copilot Auto router when it is exposed", () => {
    expect(selectPreferredModel([opus, haiku, auto], "auto")?.model).toBe(auto);
    expect(selectPreferredModel([opus, haiku, auto], undefined)?.model).toBe(auto);
  });

  it("falls back to a fast Copilot model, then the first Copilot model, for auto", () => {
    expect(selectPreferredModel([other, opus, haiku], "auto")?.model).toBe(haiku);
    expect(selectPreferredModel([other, opus, gpt], "auto")?.model).toBe(opus);
    expect(selectPreferredModel([other], "auto")?.model).toBe(other);
  });

  it("honours a configured id, family, or display name case-insensitively", () => {
    expect(selectPreferredModel([haiku, opus], "claude-opus-5.5")?.model).toBe(opus);
    expect(selectPreferredModel([haiku, opus], "Claude Opus 5.5")?.model).toBe(opus);
    expect(selectPreferredModel([haiku, gpt], "GPT-4.1")).toEqual({ model: gpt });
  });

  it("falls back to auto with a note when the configured model is missing", () => {
    const selection = selectPreferredModel([opus, haiku], "gpt-9");
    expect(selection?.model).toBe(haiku);
    expect(selection?.note).toContain("gpt-9");
  });
});
