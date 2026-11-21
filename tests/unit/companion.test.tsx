// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Companion } from "../../webview/src/companion/Companion";

afterEach(cleanup);

const remoteInputs = [
  { name: "release", type: "string", required: true, sourceRef: "main" },
  { name: "dry_run", type: "boolean", required: false, defaultValue: "true", sourceRef: "main" },
  { name: "region", type: "choice", required: true, options: ["us", "eu"], sourceRef: "main" },
  { name: "version", type: "number", required: true, sourceRef: "main" },
  { name: "target", type: "environment", required: true, sourceRef: "main" },
] as const;

function remoteResponse(
  inputs: Record<string, string>,
  review = false,
) {
  const valid = Object.keys(inputs).length === 5;
  return {
    target: {
      state: "available",
      workflowId: 7,
      workflowPath: ".github/workflows/release.yml",
      ref: "main",
      defaultBranch: "main",
      inputs: remoteInputs,
    },
    validation: {
      valid,
      values: inputs,
      errors: valid ? {} : { release: "This input is required." },
    },
    ...(review && valid ? { reviewToken: "c35c7c97-5d81-4531-a867-16a99ce0717f" } : {}),
    environmentInventory: { state: "permission_restricted", manualEntryAllowed: true },
  };
}

describe("workflow Companion dispatch form", () => {
  it("shows no drift banner when local YAML matches remote and renders all five remote input types", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "workflow.localPreview") {
          return {
            workflowPath: ".github/workflows/release.yml",
            dispatchable: true,
            inputs: remoteInputs,
            warning: "This local YAML is preview-only and will not be executed or uploaded.",
          };
        }
        return remoteResponse({ "dry_run": "true" });
      }),
    };
    render(<Companion
      bridge={bridge}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      onClose={() => undefined}
    />);

    expect(await screen.findByLabelText(/^release/i)).toBeTruthy();
    expect(screen.queryByText(/Unpushed local YAML differs/)).toBeNull();
    expect(screen.queryByText(/preview-only/)).toBeNull();
    expect(screen.getByLabelText(/^dry_run/i)).toBeTruthy();
    expect(screen.getByLabelText(/^region/i)).toBeTruthy();
    expect(screen.getByLabelText(/^version/i)).toBeTruthy();
    expect(screen.getByLabelText(/^target/i)).toBeTruthy();
    expect(screen.getByText(/Environment listing is restricted/)).toBeTruthy();
  });

  it("compares unpublished editor inputs with the remote revision", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "workflow.localPreview") {
          return {
            workflowPath: ".github/workflows/release.yml",
            dispatchable: true,
            inputs: [{ ...remoteInputs[0], description: "Local unsaved description" }],
            warning: "This local YAML is preview-only and will not be executed or uploaded.",
          };
        }
        return remoteResponse({ dry_run: "true" });
      }),
    };
    render(<Companion
      bridge={bridge}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      onClose={() => undefined}
    />);
    expect(await screen.findByText(/Unpushed local YAML differs from remote main/)).toBeTruthy();
    expect(screen.getByText("Changed locally, preview only")).toBeTruthy();
    expect(bridge.request.mock.calls.some(([operation]) => operation === "dispatch.submit")).toBe(false);
  });

  it("keeps local-only workflows previewable and blocks remote dispatch", async () => {
    const bridge = {
      request: vi.fn(async () => ({
        workflowPath: ".github/workflows/local.yml",
        dispatchable: true,
        inputs: remoteInputs,
        warning: "This local YAML is preview-only and will not be executed or uploaded.",
      })),
    };
    render(<Companion
      bridge={bridge}
      workflowPath=".github/workflows/local.yml"
      workflowName="Local"
      onClose={() => undefined}
    />);
    expect(await screen.findByText(/not present in the remote repository and cannot be dispatched/)).toBeTruthy();
    expect(screen.getByText("Local-only workflow")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Load remote inputs" }) as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(bridge.request).toHaveBeenCalledWith(
      "workflow.localPreview",
      { workflowPath: ".github/workflows/local.yml" },
    );
  });

  it("allows explicit review and submission when a remote workflow has no inputs", async () => {
    const bridge = {
      request: vi.fn(async (operation: string, payload: Record<string, unknown>) => {
        if (operation === "workflow.localPreview") {
          return {
            workflowPath: ".github/workflows/no-inputs.yml",
            dispatchable: true,
            inputs: [],
            warning: "This local YAML is preview-only and will not be executed or uploaded.",
          };
        }
        if (operation === "dispatch.submit") {
          return {
            state: "request_accepted",
            association: "not_observed",
            submittedAt: 1_800_000_000_000,
            acceptedAt: 1_800_000_001_000,
          };
        }
        const review = payload.review === true;
        return {
          target: {
            state: "available",
            workflowId: 7,
            workflowPath: ".github/workflows/no-inputs.yml",
            ref: "main",
            defaultBranch: "main",
            inputs: [],
          },
          validation: { valid: true, values: {}, errors: {} },
          ...(review ? { reviewToken: "c35c7c97-5d81-4531-a867-16a99ce0717f" } : {}),
        };
      }),
    };
    render(<Companion
      bridge={bridge}
      workflowId={7}
      workflowPath=".github/workflows/no-inputs.yml"
      workflowName="No inputs"
      onClose={() => undefined}
    />);
    fireEvent.click(await screen.findByRole("button", { name: "Run workflow" }));
    expect(await screen.findByText(/GitHub accepted the dispatch/)).toBeTruthy();
    expect(screen.getByText("Request accepted")).toBeTruthy();
  });

  it("offers one-run auto-approval only for workflows with environment gates and sends the opt-in on submit", async () => {
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/tf.yml", dispatchable: true, inputs: [], warning: "This local YAML is preview-only and will not be executed or uploaded." };
      }
      if (operation === "dispatch.submit") {
        return {
          state: "request_accepted",
          association: "not_observed",
          submittedAt: 1_800_000_000_000,
          acceptedAt: 1_800_000_001_000,
          ...(payload.autoApproveEnvironments ? { autoApproval: { environments: ["prod"], unresolved: [] } } : {}),
        };
      }
      return {
        target: {
          state: "available",
          workflowId: 7,
          workflowPath: ".github/workflows/tf.yml",
          ref: "main",
          defaultBranch: "main",
          inputs: [{ name: "environment", type: "choice", required: true, options: ["dev", "prod"], defaultValue: "dev", sourceRef: "main" }],
          environments: [{ job: "plan_apply", expression: "${{ inputs.environment }}" }],
        },
        validation: { valid: true, values: { environment: "prod" }, errors: {} },
        ...(payload.review === true ? { reviewToken: "c35c7c97-5d81-4531-a867-16a99ce0717f" } : {}),
      };
    });
    render(<Companion bridge={{ request }} workflowId={7} workflowPath=".github/workflows/tf.yml" workflowName="TF" onClose={() => undefined} />);

    const consent = await screen.findByLabelText(/I understand the risks/);
    expect(screen.getByLabelText("Auto-approval").textContent).toContain("Covers: prod");
    fireEvent.click(consent);
    expect(screen.getByText(/ActionDeck will approve prod for this run only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(await screen.findByText(/Auto-approval armed for prod/)).toBeTruthy();
    const submit = request.mock.calls.find(([operation]) => operation === "dispatch.submit");
    expect(submit?.[1]).toMatchObject({ autoApproveEnvironments: true });
    // The opt-in is cleared after each dispatch so it never carries over to the next run.
    expect((screen.getByLabelText(/I understand the risks/) as HTMLInputElement).checked).toBe(false);
  });

  it("suggests cached remote branches, accepts any typed ref, and reloads inputs for the chosen ref", async () => {
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "repository.branches") return { names: ["main", "release/1.2"], truncated: false, cachedAt: 1 };
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: [], warning: "This local YAML is preview-only and will not be executed or uploaded." };
      }
      const response = remoteResponse({});
      return { ...response, target: { ...response.target, ref: (payload.ref as string | undefined) || "main" } };
    });
    const { container } = render(<Companion bridge={{ request }} workflowId={7} workflowPath=".github/workflows/release.yml" workflowName="Release" onClose={() => undefined} />);

    const refInput = await screen.findByLabelText("Remote branch or ref");
    expect(await screen.findByText(/2 remote branches/)).toBeTruthy();
    // Opening shows every branch even though the field is prefilled with "main".
    fireEvent.focus(refInput);
    expect([...container.querySelectorAll("[role=option]")].map((option) => option.textContent))
      .toEqual(["main", "release/1.2"]);
    fireEvent.mouseDown(screen.getByRole("option", { name: "release/1.2" }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("dispatch.validate", { workflowId: 7, ref: "release/1.2", inputs: {} }));

    fireEvent.change(refInput, { target: { value: "v1.2.0" } });
    expect(screen.getByText(/Not a listed branch/)).toBeTruthy();
    fireEvent.blur(refInput);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("dispatch.validate", { workflowId: 7, ref: "v1.2.0", inputs: {} }));

    fireEvent.click(screen.getByRole("button", { name: "Reload remote branches" }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("repository.branches", { refresh: true }));
  });

  it("opens on the checked-out branch and pins main/master at the top of the list", async () => {
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "repository.branches") {
        return { names: ["alpha", "feature/x", "master", "main", "zeta"], truncated: false, cachedAt: 1, current: "feature/x" };
      }
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: [], warning: "This local YAML is preview-only and will not be executed or uploaded." };
      }
      const response = remoteResponse({});
      return { ...response, target: { ...response.target, ref: (payload.ref as string | undefined) || "main" } };
    });
    const { container } = render(<Companion bridge={{ request }} workflowId={7} workflowPath=".github/workflows/release.yml" workflowName="Release" onClose={() => undefined} />);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("dispatch.validate", { workflowId: 7, ref: "feature/x", inputs: {} }));
    expect(request.mock.calls.filter(([operation]) => operation === "dispatch.validate")).toHaveLength(1);
    const refInput = await screen.findByLabelText("Remote branch or ref");
    await vi.waitFor(() => expect((refInput as HTMLInputElement).value).toBe("feature/x"));
    fireEvent.focus(refInput);
    expect([...container.querySelectorAll("[role=option]")].map((option) => option.textContent))
      .toEqual(["main", "master", "feature/xcurrent", "alpha", "zeta"]);
  });

  it("reviews and submits the exact effective values with the one-time host token", async () => {
    const bridge = {
      request: vi.fn(async (operation: string, payload: Record<string, unknown>) => {
        if (operation === "workflow.localPreview") {
          return {
            workflowPath: ".github/workflows/release.yml",
            dispatchable: true,
            inputs: remoteInputs,
            warning: "This local YAML is preview-only and will not be executed or uploaded.",
          };
        }
        if (operation === "dispatch.submit") {
          return {
            state: "request_accepted",
            association: "not_observed",
            submittedAt: 1_800_000_000_000,
            acceptedAt: 1_800_000_001_000,
          };
        }
        if (operation === "dispatch.association") {
          return {
            state: "associated_run_found",
            runId: 21,
            runStatus: "queued",
            htmlUrl: "https://github.com/acme/demo/actions/runs/21",
          };
        }
        return remoteResponse(payload.inputs as Record<string, string>, payload.review === true);
      }),
    };
    render(<Companion
      bridge={bridge}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      onClose={() => undefined}
    />);

    await screen.findByLabelText(/^release/i);
    fireEvent.change(screen.getByLabelText(/^release/i), { target: { value: "2026.11" } });
    fireEvent.click(screen.getByLabelText(/^dry_run/i));
    fireEvent.change(screen.getByLabelText(/^region/i), { target: { value: "eu" } });
    fireEvent.change(screen.getByLabelText(/^version/i), { target: { value: "2.0" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "production" } });

    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await screen.findByText(/GitHub accepted the dispatch/);
    expect(bridge.request).toHaveBeenLastCalledWith("dispatch.submit", {
      workflowId: 7,
      ref: "main",
      inputs: {
        release: "2026.11",
        dry_run: "false",
        region: "eu",
        version: "2.0",
        target: "production",
      },
      reviewToken: "c35c7c97-5d81-4531-a867-16a99ce0717f",
    });
    fireEvent.click(screen.getByRole("button", { name: "Find run" }));
    expect(await screen.findByText("Run #21 observed (queued).")).toBeTruthy();
    expect(bridge.request).toHaveBeenLastCalledWith("dispatch.association", {
      workflowId: 7,
      ref: "main",
      submittedAt: 1_800_000_000_000,
      acceptedAt: 1_800_000_001_000,
    });
  });

  it("invalidates the review token when target values change and does not submit stale values", async () => {
    const bridge = {
      request: vi.fn(async (operation: string, payload: Record<string, unknown>) => {
        if (operation === "workflow.localPreview") {
          return {
            workflowPath: ".github/workflows/release.yml",
            dispatchable: true,
            inputs: remoteInputs,
            warning: "This local YAML is preview-only and will not be executed or uploaded.",
          };
        }
        if (operation === "dispatch.submit") return {
          state: "request_accepted",
          association: "not_observed",
          submittedAt: 1_800_000_000_000,
          acceptedAt: 1_800_000_001_000,
        };
        return remoteResponse(payload.inputs as Record<string, string>, payload.review === true);
      }),
    };
    render(<Companion
      bridge={bridge}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      onClose={() => undefined}
    />);
    await screen.findByLabelText(/^release/i);
    fireEvent.change(screen.getByLabelText(/^release/i), { target: { value: "2026.11" } });
    fireEvent.click(screen.getByLabelText(/^dry_run/i));
    fireEvent.change(screen.getByLabelText(/^region/i), { target: { value: "eu" } });
    fireEvent.change(screen.getByLabelText(/^version/i), { target: { value: "2.0" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "production" } });
    fireEvent.change(screen.getByLabelText(/^version/i), { target: { value: "3.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await screen.findByText(/GitHub accepted the dispatch/);
    expect(bridge.request).toHaveBeenLastCalledWith("dispatch.submit", expect.objectContaining({
      inputs: expect.objectContaining({ version: "3.0" }),
    }));
  });
});

describe("previous-run prefill", () => {
  it("prefills only safe schema fields and never dispatches while opening", async () => {
    const definitions = [
      ...remoteInputs,
      { name: "deploy_token", type: "string", required: false, sourceRef: "release/1" },
    ] as const;
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: definitions, warning: "preview" };
      }
      return {
        target: {
          state: "available",
          workflowId: 7,
          workflowPath: ".github/workflows/release.yml",
          ref: payload.ref || "main",
          defaultBranch: "main",
          inputs: definitions,
        },
        validation: { valid: true, values: payload.inputs as Record<string, string>, errors: {} },
      };
    });
    render(<Companion
      bridge={{ request }}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      initialRef="release/1"
      initialInputs={[
        { name: "release", value: "2026.11" },
        { name: "deploy_token", value: "top-secret" },
        { name: "removed_field", value: "stale" },
      ]}
      onClose={() => undefined}
    />);

    const release = await screen.findByLabelText(/^release/i);
    await vi.waitFor(() => expect((release as HTMLInputElement).value).toBe("2026.11"));
    expect((screen.getByLabelText(/^deploy_token/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue("top-secret")).toBeNull();
    expect(screen.getByText(/Sensitive inputs were omitted/)).toBeTruthy();
    expect(request).toHaveBeenCalledWith("dispatch.validate", {
      workflowId: 7,
      ref: "release/1",
      inputs: { release: "2026.11", removed_field: "stale" },
    });
    expect(request.mock.calls.some(([operation]) => operation === "dispatch.submit")).toBe(false);
  });

  it("loads a selected previous run for review without dispatching", async () => {
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "repository.branches") return { names: ["main"], truncated: false, cachedAt: 1 };
      if (operation === "workflow.localPreview") return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: remoteInputs, warning: "preview" };
      if (operation === "run.inspect") return { ref: "release/1", dispatchInputs: [{ name: "release", value: "2026.11" }, { name: "deploy_token", value: "secret" }] };
      return {
        target: { state: "available", workflowId: 7, ref: payload.ref || "main", defaultBranch: "main", inputs: remoteInputs },
        validation: { valid: true, values: payload.inputs as Record<string, string>, errors: {} },
      };
    });
    render(<Companion
      bridge={{ request }}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      previousRuns={[{ id: 42, displayTitle: "Release", branch: "release/1" } as never]}
      onClose={() => undefined}
    />);
    fireEvent.change(await screen.findByLabelText("Start from a previous run"), { target: { value: "42" } });
    await screen.findByText("Starting from run #42");
    await vi.waitFor(() => expect((screen.getByLabelText(/^release/i) as HTMLInputElement).value).toBe("2026.11"));
    expect(screen.getByText(/Sensitive inputs were omitted/)).toBeTruthy();
    expect(screen.queryByDisplayValue("secret")).toBeNull();
    expect(request.mock.calls.some(([operation]) => operation === "dispatch.submit")).toBe(false);
  });

  it("explains when recorded history is unavailable", async () => {
    const request = vi.fn(async (operation: string) => {
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: remoteInputs, warning: "preview" };
      }
      return remoteResponse({ dry_run: "true" });
    });
    render(<Companion
      bridge={{ request }}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      initialRef="main"
      onClose={() => undefined}
    />);

    expect(await screen.findByText(/Recorded inputs are unavailable/)).toBeTruthy();
    expect(screen.getByText(/GitHub does not return historical dispatch values/)).toBeTruthy();
  });

  it("resets prefilled edits to workflow defaults without dispatching", async () => {
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: remoteInputs, warning: "preview" };
      }
      return {
        target: { state: "available", workflowId: 7, workflowPath: ".github/workflows/release.yml", ref: "main", defaultBranch: "main", inputs: remoteInputs },
        validation: { valid: true, values: payload.inputs as Record<string, string>, errors: {} },
      };
    });
    render(<Companion
      bridge={{ request }}
      workflowId={7}
      workflowPath=".github/workflows/release.yml"
      workflowName="Release"
      initialRef="main"
      initialInputs={[{ name: "release", value: "2026.11" }]}
      onClose={() => undefined}
    />);

    const release = await screen.findByLabelText(/^release/i);
    await vi.waitFor(() => expect((release as HTMLInputElement).value).toBe("2026.11"));
    fireEvent.change(release, { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect((release as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^dry_run/i) as HTMLInputElement).checked).toBe(true);
    expect(request.mock.calls.some(([operation]) => operation === "dispatch.submit")).toBe(false);
  });

  it("does not dispatch when a different ref is selected", async () => {
    const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "repository.branches") return { names: ["main", "release/2"], truncated: false, cachedAt: 1 };
      if (operation === "workflow.localPreview") {
        return { workflowPath: ".github/workflows/release.yml", dispatchable: true, inputs: remoteInputs, warning: "preview" };
      }
      return remoteResponse({}, payload.review === true);
    });
    render(<Companion bridge={{ request }} workflowId={7} workflowPath=".github/workflows/release.yml" workflowName="Release" onClose={() => undefined} />);
    const refInput = await screen.findByLabelText("Remote branch or ref");
    fireEvent.focus(refInput);
    fireEvent.mouseDown(await screen.findByRole("option", { name: "release/2" }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("dispatch.validate", { workflowId: 7, ref: "release/2", inputs: {} }));
    expect(request.mock.calls.some(([operation]) => operation === "dispatch.submit")).toBe(false);
  });
});
