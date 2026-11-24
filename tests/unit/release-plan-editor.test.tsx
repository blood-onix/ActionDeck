// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReleasePlanEditor } from "../../webview/src/dashboard/ReleasePlanEditor";
import { PlanSteps } from "../../webview/src/components/PlanSteps";
import { ScheduleNotice } from "../../webview/src/components/ScheduleNotice";
import type { Bridge } from "../../webview/src/bridge";

const workflows = Array.from({ length: 5 }, (_, i) => ({
  workflowId: i + 1,
  name: `WF ${i + 1}`,
  path: `.github/workflows/wf${i + 1}.yml`,
  defaultBranch: "main",
}));

type DefinitionHandler = (payload: { workflowId: number; ref?: string }) => unknown;

const unavailableDefinition: DefinitionHandler = () => {
  throw new Error("offline");
};

function setup(definition: DefinitionHandler = unavailableDefinition, selected = workflows) {
  const request = vi.fn().mockImplementation(async (op: string, payload: unknown) => {
    if (op === "dispatch.validate") return definition(payload as { workflowId: number; ref?: string });
    return payload;
  });
  const onSaved = vi.fn();
  const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;
  render(<ReleasePlanEditor bridge={bridge} workflows={selected} onSaved={onSaved} onClose={() => {}} />);
  return { request, onSaved };
}

function planSaveCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(([op]) => op === "plan.save");
}

function savedPlan<T>(request: ReturnType<typeof vi.fn>): T {
  return planSaveCalls(request)[0]?.[1] as T;
}

function terraformDefinition(payload: { workflowId: number; ref?: string }) {
  return {
    target: {
      state: "available",
      workflowId: payload.workflowId,
      ref: payload.ref ?? "main",
      inputs: [
        { name: "environment", type: "choice", required: true, options: ["dev", "qa", "prod"], defaultValue: "dev", sourceRef: "main" },
        { name: "dry_run", type: "boolean", required: false, defaultValue: "false", sourceRef: "main" },
      ],
      environments: [{ job: "plan_apply", expression: "${{ inputs.environment }}" }],
    },
    validation: { valid: true, values: { environment: "dev", dry_run: "false" }, errors: {} },
  };
}

describe("ReleasePlanEditor", () => {
  afterEach(cleanup);

  it("includes every selected workflow with editable inputs and masks sensitive names", async () => {
    const { request } = setup();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);

    const path = ".github/workflows/wf5.yml";
    fireEvent.click(await screen.findByRole("button", { name: `Add input for ${path}` }));
    fireEvent.change(screen.getByLabelText(`Input 1 name for ${path}`), { target: { value: "deploy_token" } });
    expect((screen.getByLabelText(`Input 1 value for ${path}`) as HTMLInputElement).type).toBe("password");
    fireEvent.change(screen.getByLabelText(`Input 1 value for ${path}`), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: `Add input for ${path}` }));
    fireEvent.change(screen.getByLabelText(`Input 2 name for ${path}`), { target: { value: "env" } });
    fireEvent.change(screen.getByLabelText(`Input 2 value for ${path}`), { target: { value: "prod" } });
    expect((screen.getByLabelText(`Input 2 value for ${path}`) as HTMLInputElement).type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{ steps: Array<{ inputs: Record<string, string> }>; schedule?: unknown }>(request);
    expect(payload.steps).toHaveLength(5);
    expect(payload.steps[4]?.inputs).toEqual({ deploy_token: "abc", env: "prod" });
    expect(payload.schedule).toBeUndefined();
  });

  it("schedules a specific local date/time with a resolved timestamp and timezone preview", async () => {
    const { request } = setup();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    fireEvent.change(screen.getByLabelText("Schedule mode"), { target: { value: "absolute" } });
    fireEvent.change(screen.getByLabelText("Local date and time"), { target: { value: "2099-03-04T10:30" } });

    const preview = screen.getByLabelText("Resolved schedule").textContent ?? "";
    expect(preview).toContain(timeZone);
    expect(preview).toContain("2099");
    expect(preview).toMatch(/local VS Code Extension Host/i);

    await screen.findAllByRole("button", { name: /Add input for/ });
    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{ schedule: { kind: string; runAtMs: number; timeZone: string } }>(request);
    expect(payload.schedule).toEqual({ kind: "absolute", runAtMs: new Date("2099-03-04T10:30").getTime(), timeZone });
  });

  it("keeps relative delays and rejects past absolute times", async () => {
    const { request } = setup();
    fireEvent.change(screen.getByLabelText("Schedule mode"), { target: { value: "absolute" } });
    fireEvent.change(screen.getByLabelText("Local date and time"), { target: { value: "2001-01-01T00:00" } });
    await screen.findAllByRole("button", { name: /Add input for/ });
    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await screen.findByText(/must be in the future/i);
    expect(planSaveCalls(request)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Schedule mode"), { target: { value: "relative" } });
    fireEvent.change(screen.getByLabelText("Delay in minutes"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{ schedule: { kind: string; delayMs: number } }>(request);
    expect(payload.schedule.kind).toBe("relative");
    expect(payload.schedule.delayMs).toBe(15 * 60_000);
  });

  it("reads typed inputs from the workflow like Run now and hides the step gate for a single workflow", async () => {
    const { request } = setup(terraformDefinition, workflows.slice(0, 1));
    const choice = await screen.findByLabelText(/^environment/);
    expect((choice as HTMLSelectElement).value).toBe("dev");
    expect(screen.queryByRole("button", { name: /Add input for/ })).toBeNull();
    expect(screen.queryByLabelText(/Gate for/)).toBeNull();
    expect(request).toHaveBeenCalledWith("dispatch.validate", { workflowId: 1, ref: "main", inputs: {} });

    fireEvent.change(choice, { target: { value: "prod" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{ steps: Array<{ inputs: Record<string, string>; autoApprove?: unknown }> }>(request);
    expect(payload.steps[0]?.inputs).toEqual({ environment: "prod", dry_run: "false" });
    expect(payload.steps[0]?.autoApprove).toBeUndefined();
  });

  it("saves a one-run auto-approval scope resolved from the dispatched inputs only after consent", async () => {
    const { request } = setup(terraformDefinition, workflows.slice(0, 2));
    expect(await screen.findAllByLabelText(/Gate for/)).toHaveLength(2);
    const consents = await screen.findAllByLabelText(/I understand the risks/);
    fireEvent.change(screen.getAllByLabelText(/^environment/)[0]!, { target: { value: "qa" } });
    fireEvent.click(consents[0]!);
    expect(screen.getByText(/ActionDeck will approve qa/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{ steps: Array<{ autoApprove?: { environments: string[] | null } }> }>(request);
    expect(payload.steps[0]?.autoApprove).toEqual({ environments: ["qa"] });
    expect(payload.steps[1]?.autoApprove).toBeUndefined();
  });

  it("renders PlanSteps gate chips and ScheduleNotice scheduled/missed states without auto-starting", () => {
    const { container, unmount } = render(
      <>
        <PlanSteps
          steps={[
            { name: "Build", workflow: "build.yml", ref: "main", status: "success" },
            { name: "Stage", workflow: "stage.yml", ref: "main", status: "running", gate: "on_success", pauseBefore: true },
            { name: "Notify", workflow: "notify.yml", ref: "main", status: "queued", gate: "on_any" },
          ]}
        />
        <ScheduleNotice state="scheduled" startsIn="14:20" at="16:00" />
        <ScheduleNotice state="missed" at="15:00" />
      </>,
    );
    expect(screen.getByText("Runs only if the step above succeeds")).toBeTruthy();
    expect(screen.getByText("Runs whatever the result above")).toBeTruthy();
    expect(container.querySelector(".ad-gate--any")).toBeTruthy();
    expect(screen.getByText("Pause before")).toBeTruthy();
    expect(screen.getByText(/Scheduling lives in this VS Code window/i)).toBeTruthy();
    expect(screen.getByText("Missed schedule. Waiting for you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start now" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Cancel plan" }).length).toBeGreaterThan(0);
    unmount();
  });
});

describe("ReleasePlanEditor editing a saved plan", () => {
  afterEach(cleanup);

  const saved = {
    id: "plan-42",
    name: "Platform release",
    repositoryId: "repo-1",
    state: "scheduled" as const,
    currentStepIndex: 0,
    updatedAt: 1,
    schedule: { kind: "relative" as const, runAtMs: new Date(2030, 0, 15, 9, 30).getTime(), delayMs: 600_000, timeZone: "UTC" },
    steps: [
      {
        id: "step-1", workflowId: 1, workflowPath: ".github/workflows/infra-network.yml", ref: "main",
        inputs: { environment: "qa" }, sensitiveInputKeys: [], gate: "on_success" as const, state: "pending" as const,
      },
      {
        id: "step-2", workflowId: 2, workflowPath: ".github/workflows/infra-storage.yml", ref: "release",
        inputs: { environment: "prod", dry_run: "true" }, sensitiveInputKeys: [], gate: "stop_on_non_success" as const, state: "pending" as const,
      },
    ],
  };

  it("opens with the saved steps, inputs and schedule and saves over the same plan", async () => {
    const request = vi.fn().mockImplementation(async (op: string, payload: unknown) => {
      if (op === "dispatch.validate") return terraformDefinition(payload as { workflowId: number; ref?: string });
      return payload;
    });
    const onSaved = vi.fn();
    render(
      <ReleasePlanEditor
        bridge={{ request, onEvent: () => () => {} } as unknown as Bridge}
        workflows={[]}
        plan={saved}
        onSaved={onSaved}
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText("Plan name") as HTMLInputElement).value).toBe("Platform release");
    expect((screen.getByLabelText("Schedule mode") as HTMLSelectElement).value).toBe("absolute");
    await waitFor(() => expect(request.mock.calls.filter(([op]) => op === "dispatch.validate")).toHaveLength(2));

    fireEvent.click(await screen.findByRole("button", { name: /Save/ }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{
      id: string;
      name: string;
      schedule?: { kind: string; runAtMs: number };
      steps: Array<{ id: string; ref: string; gate: string; inputs: Record<string, string> }>;
    }>(request);
    expect(payload.id).toBe("plan-42");
    expect(payload.name).toBe("Platform release");
    expect(payload.schedule).toMatchObject({ kind: "absolute", runAtMs: saved.schedule.runAtMs });
    expect(payload.steps.map((step) => [step.id, step.ref, step.gate, step.inputs])).toEqual([
      ["step-1", "main", "on_success", { environment: "qa", dry_run: "false" }],
      // The retired "stop on non-success" gate always behaved like on_success and is saved as it.
      ["step-2", "release", "on_success", { environment: "prod", dry_run: "true" }],
    ]);
  });
});

describe("ReleasePlanProgress edit action", () => {
  afterEach(cleanup);

  it("offers Edit plan only before the plan starts", async () => {
    const { ReleasePlanProgress } = await import("../../webview/src/dashboard/ReleasePlanProgress");
    const bridge = { request: vi.fn(), onEvent: () => () => {} } as unknown as Bridge;
    const base = {
      id: "plan-1", name: "Release", repositoryId: "repo-1", currentStepIndex: 0, updatedAt: 1,
      steps: [{
        id: "step-1", workflowId: 1, workflowPath: ".github/workflows/a.yml", ref: "main",
        inputs: {}, sensitiveInputKeys: [], gate: "on_success" as const, state: "pending" as const,
      }],
    };
    const onEdit = vi.fn();
    const { rerender } = render(
      <ReleasePlanProgress bridge={bridge} plan={{ ...base, state: "draft" }} onPlanUpdated={() => {}} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "plan-1" }));

    rerender(<ReleasePlanProgress bridge={bridge} plan={{ ...base, state: "running" }} onPlanUpdated={() => {}} onEdit={onEdit} />);
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });
});

describe("ReleasePlanEditor stages, waits and confirmations", () => {
  afterEach(cleanup);

  it("saves steps that start together, a wait and a confirmation before a later step", async () => {
    const { request } = setup(unavailableDefinition, workflows.slice(0, 3));
    await waitFor(() => expect(screen.getAllByText(/Could not read this workflow's inputs/).length).toBe(3));

    fireEvent.change(screen.getByLabelText("Start of .github/workflows/wf2.yml"), { target: { value: "together" } });
    // A step that starts together with the one above has no wait or confirmation of its own.
    expect(screen.queryByLabelText("Wait before .github/workflows/wf2.yml in minutes")).toBeNull();
    fireEvent.change(screen.getByLabelText("Wait before .github/workflows/wf3.yml in minutes"), { target: { value: "15" } });
    fireEvent.click(screen.getByLabelText("Ask before starting .github/workflows/wf3.yml"));
    fireEvent.change(screen.getByLabelText("Gate for .github/workflows/wf1.yml"), { target: { value: "on_any_completion" } });

    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await waitFor(() => expect(planSaveCalls(request)).toHaveLength(1));
    const payload = savedPlan<{ steps: Array<Record<string, unknown>> }>(request);
    expect(payload.steps[0]).toMatchObject({ gate: "on_any_completion" });
    expect(payload.steps[0]).not.toHaveProperty("parallelWithPrevious");
    expect(payload.steps[1]).toMatchObject({ parallelWithPrevious: true, gate: "on_success" });
    expect(payload.steps[2]).toMatchObject({ waitBeforeMinutes: 15, confirmBefore: true });
    expect(payload.steps[2]).not.toHaveProperty("parallelWithPrevious");
  });

  it("rejects a wait that is not a whole number of minutes", async () => {
    const { request } = setup(unavailableDefinition, workflows.slice(0, 2));
    await waitFor(() => expect(screen.getAllByText(/Could not read this workflow's inputs/).length).toBe(2));
    fireEvent.change(screen.getByLabelText("Wait before .github/workflows/wf2.yml in minutes"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Plan/i }));
    await screen.findByText(/must be a whole number of minutes/);
    expect(planSaveCalls(request)).toHaveLength(0);
  });
});

describe("ReleasePlanProgress holds and retries", () => {
  afterEach(cleanup);

  const base = {
    id: "plan-1", name: "Release", repositoryId: "repo-1", currentStepIndex: 1, updatedAt: 1,
    steps: [
      { id: "a", workflowId: 1, workflowPath: ".github/workflows/a.yml", ref: "main", inputs: {}, sensitiveInputKeys: [], gate: "on_success" as const, state: "completed" as const },
      { id: "b", workflowId: 2, workflowPath: ".github/workflows/b.yml", ref: "main", inputs: {}, sensitiveInputKeys: [], gate: "on_success" as const, state: "pending" as const, confirmBefore: true },
      { id: "c", workflowId: 3, workflowPath: ".github/workflows/c.yml", ref: "main", inputs: {}, sensitiveInputKeys: [], gate: "on_success" as const, state: "pending" as const, parallelWithPrevious: true },
    ],
  };

  it("offers Continue while holding for confirmation and Retry once stopped", async () => {
    const { ReleasePlanProgress } = await import("../../webview/src/dashboard/ReleasePlanProgress");
    const request = vi.fn(async (_operation: string, payload: { planId: string }) => ({ ...base, id: payload.planId, state: "running" }));
    const bridge = { request, onEvent: () => () => {} } as unknown as Bridge;
    const { rerender } = render(
      <ReleasePlanProgress bridge={bridge} plan={{ ...base, state: "on_hold", hold: { kind: "confirm" } }} onPlanUpdated={() => {}} />,
    );
    expect(screen.getByText("Asks before starting")).toBeTruthy();
    expect(screen.getByText("Starts together with the step above")).toBeTruthy();
    expect(screen.getByText(/Waiting for you to continue before step 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("plan.continue", { planId: "plan-1", runtimeInputs: {} }));

    rerender(
      <ReleasePlanProgress
        bridge={bridge}
        plan={{ ...base, state: "on_hold", hold: { kind: "wait", untilMs: Date.now() + 60_000 } }}
        onPlanUpdated={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Start now" })).toBeTruthy();

    rerender(
      <ReleasePlanProgress
        bridge={bridge}
        plan={{ ...base, state: "stopped", steps: base.steps.map((s) => s.id === "b" ? { ...s, state: "failed" as const, conclusion: "failure" } : s) }}
        onPlanUpdated={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("plan.retry", { planId: "plan-1", runtimeInputs: {} }));

    rerender(<ReleasePlanProgress bridge={bridge} plan={{ ...base, state: "completed" }} onPlanUpdated={() => {}} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
