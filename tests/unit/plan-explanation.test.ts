import { describe, expect, it } from "vitest";
import { explainBlockedPlan } from "../../src/application/copilot/plan-explanation";
import type { ReleasePlan } from "../../src/domain/models/release-plan";

const plan: ReleasePlan = {
  id: "p",
  name: "Release",
  repositoryId: "r",
  state: "blocked_uncertain",
  currentStepIndex: 0,
  updatedAt: 0,
  blockedReason: "Step build outcome is uncertain (ambiguous). token=abc123",
  steps: [{
    id: "s", workflowId: 1, workflowPath: ".github/workflows/build.yml", ref: "main", inputs: {},
    sensitiveInputKeys: [], gate: "stop_on_non_success", state: "outcome_uncertain", error: "ambiguous",
  }],
};

describe("explainBlockedPlan", () => {
  it("falls back to a deterministic redacted summary without a model", async () => {
    const result = await explainBlockedPlan(plan);
    expect(result.mode).toBe("fallback");
    expect(result.observedFacts.join(" ")).not.toContain("abc123");
    expect(result.likelyExplanations[0]).toContain("could not confirm");
  });

  it("uses model sections and treats plan data as untrusted evidence", async () => {
    let prompt = "";
    const result = await explainBlockedPlan(plan, {
      isAvailable: async () => true,
      sendRequest: async (request) => {
        prompt = request.system;
        return { ok: true, text: "## Likely Explanations\n- Two runs matched\n## Suggested Next Steps\n- Inspect runs" };
      },
    });
    expect(result.mode).toBe("model");
    expect(result.likelyExplanations).toEqual(["Two runs matched"]);
    expect(prompt).toContain("UNTRUSTED");
  });
});
