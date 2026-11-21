import { describe, expect, it } from "vitest";
import { parseWorkflowEnvironments } from "../../src/application/workflows/workflow-environments";
import { resolveAutoApprovalScope, scopeCoversEnvironment } from "../../src/domain/services/auto-approval-scope";

const workflow = `
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [dev, qa, prod]
jobs:
  plan:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  plan_apply:
    name: Manual
    if: github.event_name == 'workflow_dispatch'
    environment: \${{ inputs.environment }}
    steps: [{ run: echo }]
  notify:
    environment:
      name: ops-\${{ github.event.inputs['environment'] }}
      url: https://example.test
  audit:
    environment: audit
  shared:
    uses: ./.github/workflows/deploy.yml
`;

describe("workflow environments and one-run auto-approval scope", () => {
  it("lists literal, expression and reusable-workflow environments per job", () => {
    expect(parseWorkflowEnvironments(workflow)).toEqual([
      { job: "plan_apply", expression: "${{ inputs.environment }}" },
      { job: "notify", expression: "ops-${{ github.event.inputs['environment'] }}" },
      { job: "audit", name: "audit" },
      { job: "shared", expression: "reusable workflow" },
    ]);
    expect(parseWorkflowEnvironments("jobs: [")).toEqual([]);
  });

  it("substitutes dispatched inputs and widens to every gate when something stays unresolved", () => {
    const refs = parseWorkflowEnvironments(workflow);
    const withoutReusable = refs.filter((ref) => ref.job !== "shared");
    expect(resolveAutoApprovalScope(withoutReusable, { environment: "prod" })).toEqual({
      environments: ["prod", "ops-prod", "audit"],
      unresolved: [],
    });
    expect(resolveAutoApprovalScope(withoutReusable, {}).environments).toBeNull();
    expect(resolveAutoApprovalScope(refs, { environment: "prod" })).toEqual({
      environments: null,
      unresolved: ["shared: reusable workflow"],
    });
    expect(resolveAutoApprovalScope([{ job: "x", expression: "${{ vars.TARGET }}" }], {}).environments).toBeNull();
  });

  it("matches environment names case-insensitively", () => {
    expect(scopeCoversEnvironment(["Prod"], "prod")).toBe(true);
    expect(scopeCoversEnvironment(["qa"], "prod")).toBe(false);
    expect(scopeCoversEnvironment(null, "anything")).toBe(true);
  });
});
