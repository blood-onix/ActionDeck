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
    expect(screen.getByText("Runs only on success")).toBeTruthy();
    expect(screen.getByText("Runs on any completion")).toBeTruthy();
    expect(container.querySelector(".ad-gate--any")).toBeTruthy();
    expect(screen.getByText("Pause before")).toBeTruthy();
    expect(screen.getByText(/Scheduling lives in this VS Code window/i)).toBeTruthy();
    expect(screen.getByText("Missed schedule. Waiting for you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start now" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Cancel plan" }).length).toBeGreaterThan(0);
    unmount();
  });
});
