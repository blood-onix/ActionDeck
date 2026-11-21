// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BatchForm } from "../../webview/src/dashboard/BatchForm";
import type { Bridge } from "../../webview/src/bridge";

describe("BatchForm UI", () => {
  afterEach(cleanup);

  it("displays compatibility conflicts, effective target values, and invalidates review on edit", async () => {
    const request = vi.fn().mockResolvedValue({
      valid: true,
      reviewToken: "11111111-1111-4111-8111-111111111111",
      compatibility: {
        fields: [
          {
            name: "env",
            compatible: false,
            conflicts: ["options_mismatch"],
            hasDifferentDefaults: true,
            types: ["choice"],
          },
        ],
      },
      resolvedItems: [
        { workflowId: 1, workflowPath: ".github/workflows/a.yml", ref: "main", effectiveInputs: { env: "staging" }, errors: {} },
        { workflowId: 2, workflowPath: ".github/workflows/b.yml", ref: "main", effectiveInputs: { env: "qa" }, errors: {} },
      ],
    });
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;

    render(
      <BatchForm
        bridge={bridge}
        workflows={[
          { workflowId: 1, name: "Build A", path: ".github/workflows/a.yml", defaultBranch: "main" },
          { workflowId: 2, name: "Build B", path: ".github/workflows/b.yml", defaultBranch: "main" },
        ]}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Review batch/i }));
    await screen.findByText(/Choices mismatch/i);
    const runBtn = screen.getByRole("button", { name: /Run selected \(2\)/i }) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Keep a value per workflow"));
    expect(runBtn.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText(/Global ref/i), { target: { value: "release" } });
    expect(runBtn.disabled).toBe(true);
  });

  it("sends per-workflow overrides from collapsible workflow inputs and masks sensitive names", async () => {
    const request = vi.fn().mockResolvedValue({
      valid: true,
      reviewToken: "11111111-1111-4111-8111-111111111111",
      compatibility: { fields: [] },
      resolvedItems: [
        {
          workflowId: 1,
          workflowPath: ".github/workflows/a.yml",
          ref: "main",
          effectiveInputs: { env: "staging", deploy_token: "super-secret-value" },
          errors: {},
        },
        { workflowId: 2, workflowPath: ".github/workflows/b.yml", ref: "main", effectiveInputs: {}, errors: {} },
      ],
    });
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;
    render(
      <BatchForm
        bridge={bridge}
        workflows={[
          { workflowId: 1, name: "Build A", path: ".github/workflows/a.yml", defaultBranch: "main" },
          { workflowId: 2, name: "Build B", path: ".github/workflows/b.yml", defaultBranch: "main" },
        ]}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Review batch/i }));
    await screen.findByText(/Workflow-specific inputs for \.github\/workflows\/a\.yml/);
    expect(document.body.textContent).not.toContain("super-secret-value");
    const tokenInput = screen.getByLabelText("Override deploy_token for .github/workflows/a.yml") as HTMLInputElement;
    expect(tokenInput.type).toBe("password");

    fireEvent.change(screen.getByLabelText("Override env for .github/workflows/a.yml"), { target: { value: "prod" } });
    expect((screen.getByRole("button", { name: /Run selected \(2\)/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Review batch/i }));
    await waitFor(() => expect((screen.getByRole("button", { name: /Run selected \(2\)/i }) as HTMLButtonElement).disabled).toBe(false));

    expect(request).toHaveBeenLastCalledWith("batch.validate", expect.objectContaining({
      perWorkflowOverrides: { 1: { env: "prod" } },
    }));
  });
});
