// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunInspector } from "../../webview/src/inspector/RunInspector";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("run inspector", () => {
  it("switches attempts, requests selected-job logs, and renders log content as plain text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const bridge = {
      request: vi.fn(async (operation: string, payload: Record<string, unknown>) => {
        if (operation === "run.inspect") {
          const attempt = Number(payload.attempt ?? 2);
          return {
            runId: 55,
            attempt,
            attemptCount: 2,
            dependencyResolution: "resolved",
            title: "build run",
            status: "completed",
            conclusion: "failure",
            htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [{
              id: attempt * 10,
              runId: 55,
              attempt,
              name: `Build attempt ${attempt}`,
              status: "completed",
              conclusion: "failure",
              steps: [{ number: 1, name: "Build", status: "completed", conclusion: "failure" }],
            }],
          };
        }
        return { text: "<script>alert(1)</script>\ntoken=secret", truncated: false, availability: "loaded" };
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    await screen.findByText(/Build attempt 2/);
    fireEvent.change(screen.getByLabelText("Run attempt"), { target: { value: "1" } });
    await screen.findByText(/Build attempt 1/);
    expect(bridge.request).toHaveBeenCalledWith("run.inspect", { runId: 55, attempt: 1 }, expect.any(AbortSignal));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("run.logs.load", {
      runId: 55, attempt: 1, jobId: 10, stepNumber: 1,
    }, expect.any(AbortSignal)));

    fireEvent.click(await screen.findByText("Build"));
    await waitFor(() => expect(document.querySelector(".log-text")?.textContent).toContain("<script>alert(1)</script>"));
    expect(document.querySelector(".log-text")?.tagName).toBe("PRE");
    fireEvent.change(screen.getByLabelText("Search job log"), { target: { value: "token" } });
    expect(screen.getByText("1 of 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("<script>alert(1)</script>\ntoken=secret"));
    expect(bridge.request).toHaveBeenLastCalledWith("run.logs.load", {
      runId: 55, attempt: 1, jobId: 10, stepNumber: 1,
    }, expect.any(AbortSignal));
  });

  it("opens the known failing step automatically and never requests other job logs", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") return {
          runId: 66, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
          title: "publish", status: "completed", conclusion: "failure",
          htmlUrl: "https://github.com/acme/demo/actions/runs/66",
          jobs: [
            { id: 1, runId: 66, attempt: 1, name: "Tests", status: "completed", conclusion: "success", steps: [] },
            { id: 2, runId: 66, attempt: 1, name: "Publish", status: "completed", conclusion: "failure", steps: [
              { number: 7, name: "Upload artifacts", status: "completed", conclusion: "failure" },
            ] },
          ],
        };
        return { text: "dist/storefront-api_2.8.0_linux_amd64.zip\nVersion 2.8.0 already exists", truncated: false, availability: "loaded", stepBoundary: "identified" };
      }),
    };
    render(<RunInspector bridge={bridge} runId={66} onClose={() => undefined} />);
    await screen.findByText("Step log · Upload artifacts");
    await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2));
    expect(bridge.request).toHaveBeenCalledWith("run.logs.load", { runId: 66, attempt: 1, jobId: 2, stepNumber: 7 }, expect.any(AbortSignal));
    expect(screen.getAllByText(/Version 2.8.0 already exists/).length).toBeGreaterThan(0);
    expect(document.querySelector(".ad-inspector-error-summary")?.textContent).toContain("Version 2.8.0 already exists");
    expect(screen.getByRole("button", { name: "Steps · Failed at Upload artifacts" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores a stale log after switching attempts while it is pending", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const bridge = {
      request: vi.fn((operation: string, payload: Record<string, unknown>) => {
        if (operation === "run.inspect") {
          const attempt = Number(payload.attempt ?? 2);
          return Promise.resolve({
            runId: 55, attempt, attemptCount: 2, dependencyResolution: "resolved", title: `attempt ${attempt}`,
            status: "completed", conclusion: "failure", htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [{ id: attempt * 10, runId: 55, attempt, name: "Build", status: "completed", conclusion: "failure", steps: [{ number: 1, name: "Compile", status: "completed", conclusion: "failure" }] }],
          });
        }
        if (payload.attempt === 2) return new Promise((resolve) => { resolveOld = resolve; });
        return Promise.resolve({ text: "current attempt log", truncated: false, availability: "loaded" });
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    await screen.findByText("Step log · Compile");
    fireEvent.change(screen.getByLabelText("Run attempt"), { target: { value: "1" } });
    await screen.findByText("current attempt log");
    resolveOld?.({ text: "obsolete attempt log", truncated: false, availability: "loaded" });
    await waitFor(() => expect(screen.queryByText("obsolete attempt log")).toBeNull());
    expect(screen.getByText("current attempt log")).toBeTruthy();
  });

  it("shows the dispatch inputs ActionDeck recorded for the run", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation !== "run.inspect") return new Promise(() => {});
        return {
          runId: 77, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
          title: "Publish", status: "in_progress", conclusion: null,
          htmlUrl: "https://github.com/acme/demo/actions/runs/77",
          dispatchInputs: [{ name: "packageName", value: "storefront-api" }, { name: "dry_run", value: "" }],
          jobs: [],
        };
      }),
    };
    render(<RunInspector bridge={bridge} runId={77} onClose={() => undefined} />);
    expect(await screen.findByText("Recorded inputs (2)")).toBeTruthy();
    expect(screen.getByText("packageName")).toBeTruthy();
    expect(screen.getByText("storefront-api")).toBeTruthy();
    expect(screen.getByText("(not set)")).toBeTruthy();
  });

  it("hides sensitive recorded inputs and excludes them from same-input rerun", async () => {
    const onRunWithSameInputs = vi.fn();
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") return {
          runId: 78, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
          title: "Publish", status: "completed", conclusion: "failure", ref: "main",
          htmlUrl: "https://github.com/acme/demo/actions/runs/78",
          dispatchInputs: [{ name: "token", value: "do-not-render" }, { name: "version", value: "2.8.0" }],
          jobs: [],
        };
        return { runs: [] };
      }),
    };
    render(<RunInspector bridge={bridge} runId={78} onClose={() => undefined} onRunWithSameInputs={onRunWithSameInputs} />);
    await screen.findByText("(sensitive value hidden)");
    expect(screen.queryByText("do-not-render")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Re-run with same inputs" }));
    expect(onRunWithSameInputs).toHaveBeenCalledWith({
      ref: "main",
      inputs: [{ name: "token", value: "" }, { name: "version", value: "2.8.0" }],
    });
  });

  it("does not allow a late response from a previous run to replace the current inspection", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const bridge = {
      request: vi.fn((operation: string, payload: Record<string, unknown>) => {
        if (operation !== "run.inspect") return Promise.resolve({});
        if (payload.runId === 55) {
          return new Promise((resolve) => { resolveOld = resolve; });
        }
        return Promise.resolve({
          runId: 56,
          attempt: 1,
          attemptCount: 1,
          dependencyResolution: "resolved",
          title: "current run",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://github.com/acme/demo/actions/runs/56",
          jobs: [],
        });
      }),
    };
    const { rerender } = render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    rerender(<RunInspector bridge={bridge} runId={56} onClose={() => undefined} />);
    await screen.findByText(/current run/);
    resolveOld?.({
      runId: 55,
      attempt: 1,
      attemptCount: 1,
      dependencyResolution: "resolved",
      title: "obsolete run",
      status: "completed",
      conclusion: "failure",
      htmlUrl: "https://github.com/acme/demo/actions/runs/55",
      jobs: [],
    });
    await waitFor(() => expect(screen.queryByText(/obsolete run/)).toBeNull());
    expect(screen.getByText(/current run/)).toBeTruthy();
  });

  it("preserves the selected log and its scroll position when refreshing the same attempt", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 55,
            attempt: 1,
            attemptCount: 1,
            dependencyResolution: "resolved",
            title: "build run",
            status: "in_progress",
            conclusion: null,
            htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [{
              id: 10,
              runId: 55,
              attempt: 1,
              name: "Build",
              status: "in_progress",
              conclusion: null,
              steps: [{ number: 1, name: "Build", status: "in_progress", conclusion: null }],
            }],
          };
        }
        return { text: "line one\nline two\nline three", truncated: false, availability: "loaded" };
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByText("Build").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Build")[0]!);
    await waitFor(() => expect(document.querySelector(".log-text")?.textContent).toContain("line three"));
    const log = document.querySelector(".log-text") as HTMLElement;
    log.scrollTop = 42;
    fireEvent.scroll(log);

    fireEvent.click(screen.getByRole("button", { name: "Refresh run details" }));
    await waitFor(() => expect(bridge.request).toHaveBeenLastCalledWith(
      "run.inspect",
      { runId: 55, attempt: 1 },
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(document.querySelector(".log-text")).toBe(log));
    expect(log.scrollTop).toBe(42);
  });

  it("restores the scroll position when the same log reloads and resets it for a different step", async () => {
    let logText = "a\nb\nc";
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 55, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
            title: "build run", status: "in_progress", conclusion: null,
            htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [{
              id: 10, runId: 55, attempt: 1, name: "Build", status: "in_progress", conclusion: null,
              steps: [{ number: 1, name: "Build", status: "in_progress", conclusion: null }],
            }],
          };
        }
        return { text: logText, truncated: false, availability: "loaded" };
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    fireEvent.click((await screen.findAllByText("Build"))[0]!);
    await waitFor(() => expect(document.querySelector(".log-text")?.textContent).toContain("c"));
    const log = document.querySelector(".log-text") as HTMLElement;
    log.scrollTop = 30;
    fireEvent.scroll(log);

    logText = "a\nb\nc\nd";
    fireEvent.click(screen.getAllByText("Build")[0]!);
    await waitFor(() => expect(document.querySelector(".log-text")?.textContent).toContain("d"));
    expect((document.querySelector(".log-text") as HTMLElement).scrollTop).toBe(30);

    fireEvent.click(screen.getAllByText("Build")[1]!);
    await waitFor(() => expect(bridge.request).toHaveBeenLastCalledWith(
      "run.logs.load", expect.objectContaining({ stepNumber: 1 }), expect.any(AbortSignal),
    ));
    await waitFor(() => expect((document.querySelector(".log-text") as HTMLElement).scrollTop).toBe(0));
  });

  it.each([
    ["expired", "GitHub has expired this job log"],
    ["restricted", "not permitted to read this job log"],
    ["unavailable", "did not provide a log"],
  ])("explains %s logs in place without rendering log text or enabling copy", async (availability, message) => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 55, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
            title: "build run", status: "completed", conclusion: "failure",
            htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [{ id: 10, runId: 55, attempt: 1, name: "Build", status: "completed", conclusion: "failure", steps: [] }],
          };
        }
        return { text: "", truncated: false, availability, message };
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("Build"));
    await screen.findByText(new RegExp(message));
    expect(document.querySelector(".log-text")).toBeNull();
    expect((screen.getByRole("button", { name: "Copy log" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a target-bound rerun action only for a failed completed run", async () => {
    const onActionComplete = vi.fn();
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 55,
            attempt: 2,
            attemptCount: 2,
            dependencyResolution: "resolved",
            title: "build run",
            status: "completed",
            conclusion: "failure",
            htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [],
          };
        }
        return { state: "outcome_uncertain", reconciliation: "not_observed" };
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} onActionComplete={onActionComplete} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-run failed jobs" }));
    await screen.findByText(/outcome uncertain/i);
    expect(bridge.request).toHaveBeenCalledWith(
      "run.action",
      { action: "rerun_failed_jobs", runId: 55, attempt: 2 },
    );
    expect(onActionComplete).toHaveBeenCalledOnce();
  });

  it("offers rerun all jobs, not rerun failed jobs, for successful runs", async () => {
    const bridge = {
      request: vi.fn().mockResolvedValue({
        runId: 55,
        attempt: 1,
        attemptCount: 1,
        dependencyResolution: "resolved",
        title: "successful run",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/acme/demo/actions/runs/55",
        jobs: [],
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    await screen.findByText(/successful run/);
    expect(screen.queryByRole("button", { name: /Re-run failed jobs/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel run/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Re-run all jobs" }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith(
      "run.action",
      { action: "rerun_all", runId: 55, attempt: 1 },
    ));
  });

  it("offers re-run with same inputs for successful runs", async () => {
    const onRunWithSameInputs = vi.fn();
    const bridge = {
      request: vi.fn().mockResolvedValue({
        runId: 55,
        attempt: 1,
        attemptCount: 1,
        dependencyResolution: "resolved",
        title: "successful run",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/acme/demo/actions/runs/55",
        jobs: [],
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} onRunWithSameInputs={onRunWithSameInputs} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-run with same inputs" }));
    expect(onRunWithSameInputs).toHaveBeenCalledOnce();
  });

  it("sends cancellation only for the displayed active run attempt", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 55,
            attempt: 2,
            attemptCount: 2,
            dependencyResolution: "resolved",
            title: "active run",
            status: "in_progress",
            conclusion: null,
            htmlUrl: "https://github.com/acme/demo/actions/runs/55",
            jobs: [],
          };
        }
        return { state: "accepted" };
      }),
    };
    render(<RunInspector bridge={bridge} runId={55} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run #55" }));

    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith(
      "run.action",
      { action: "cancel", runId: 55, attempt: 2 },
    ));
    await screen.findByText("GitHub accepted the run action.");
  });
});

describe("run inspector Copilot actions", () => {
  it("uses identifiers from the inspected run so non-latest runs get Copilot actions", async () => {
    const summary = { mode: "fallback", availability: "no_model", observedFacts: [], likelyExplanations: [], suggestedNextSteps: [], limitations: [] };
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 7, attempt: 1, attemptCount: 1, dependencyResolution: "resolved", title: "old run", status: "completed",
            conclusion: "failure", htmlUrl: "https://github.com/acme/demo/actions/runs/7",
            workflowId: 3, workflowPath: ".github/workflows/ci.yml", ref: "release",
            jobs: [{ id: 70, runId: 7, attempt: 1, name: "Build", status: "completed", conclusion: "failure", steps: [] }],
          };
        }
        return summary;
      }),
    };
    render(<RunInspector bridge={bridge} runId={7} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Investigate in Copilot Chat" }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("run.openChat", {
      workflowId: 3, runId: 7, attempt: 1, jobId: 70, ref: "release", jobName: "Build",
      workflowPath: ".github/workflows/ci.yml",
    }));
    expect(bridge.request).not.toHaveBeenCalledWith("run.investigate", expect.anything());
    expect(screen.queryByRole("button", { name: "Suggest workflow fix" })).toBeNull();
  });

  it("runs the requested Copilot action automatically when opened from the dashboard", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => operation === "run.inspect"
        ? {
          runId: 8, attempt: 1, attemptCount: 1, dependencyResolution: "resolved", title: "run", status: "completed",
          conclusion: "failure", htmlUrl: "https://github.com/acme/demo/actions/runs/8", workflowId: 3, ref: "main",
          jobs: [{ id: 80, runId: 8, attempt: 1, name: "Test", status: "completed", conclusion: "failure", steps: [] }],
        }
        : { mode: "fallback", availability: "no_model", summary: "Job Test failed.", observedFacts: ["fact"], likelyExplanations: [], suggestedNextSteps: [], limitations: [] }),
    };
    render(<RunInspector bridge={bridge} runId={8} autoAction="explain" onClose={() => undefined} />);
    await screen.findByText("Job Test failed.");
    expect(bridge.request).toHaveBeenCalledWith("run.investigate", expect.objectContaining({ jobId: 80, presentation: "panel" }));
    expect(screen.queryByText("fact")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("fact")).toBeTruthy();
  });

  it("renders a compact explanation card and opens the log search from the error line", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 9, attempt: 1, attemptCount: 1, dependencyResolution: "resolved", title: "run", status: "completed",
            conclusion: "failure", htmlUrl: "https://github.com/acme/demo/actions/runs/9", workflowId: 3, ref: "main",
            jobs: [{
              id: 90, runId: 9, attempt: 1, name: "Plan", status: "completed", conclusion: "failure",
              steps: [{ number: 4, name: "Terraform plan", status: "completed", conclusion: "failure" }],
            }],
          };
        }
        if (operation === "run.logs.load") {
          return { text: "Planning\nError: name may only contain alphanumeric characters", truncated: false, availability: "loaded" };
        }
        if (operation === "run.openChat") return { opened: "chat" };
        return {
          mode: "model", availability: "available",
          summary: "Bucket name `Prod_Assets` breaks the naming rule.", confidence: "high",
          failedStep: "Plan › Terraform plan",
          errorLine: { line: 725, text: "Error: name may only contain alphanumeric characters" },
          model: { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
          observedFacts: ["Run 9 failed"], likelyExplanations: ["Bucket name `Prod_Assets` breaks the naming rule."],
          suggestedNextSteps: ["Shorten the suffix", "Re-run plan", "Check tfvars", "Too many"], limitations: [],
        };
      }),
    };
    render(<RunInspector bridge={bridge} runId={9} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explain failure" }));
    const card = await screen.findByRole("region", { name: "Failure explanation" });
    expect(card.textContent).toContain("high confidence");
    expect(card.textContent).toContain("Explained by Claude Haiku 5.5");
    expect(card.querySelector("code")?.textContent).toBe("Prod_Assets");
    expect(card.querySelectorAll("ol li")).toHaveLength(3);
    expect(card.textContent).not.toContain("**");

    fireEvent.click(screen.getByRole("button", { name: /L725/ }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("run.logs.load", expect.objectContaining({ jobId: 90 }), expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "Continue in Copilot Chat →" }));
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith("run.openChat", expect.objectContaining({
      jobId: 90, stepNumber: 4, stepName: "Terraform plan",
    })));
  });

  it("renders both truncation strip and Logs in progress notice when both apply, plus Ctrl+F search and [ / ] step jumps", async () => {
    const bridge = {
      request: vi.fn(async (operation: string) => {
        if (operation === "run.inspect") {
          return {
            runId: 99,
            attempt: 1,
            attemptCount: 1,
            dependencyResolution: "resolved",
            title: "live run",
            status: "in_progress",
            conclusion: null,
            htmlUrl: "https://github.com/acme/demo/actions/runs/99",
            jobs: [{ id: 90, runId: 99, attempt: 1, name: "Deploy", status: "in_progress", conclusion: null, steps: [] }],
          };
        }
        return {
          text: "",
          truncated: true,
          availability: "in_progress",
          message: "Logs are still being produced; refresh when the job completes.",
        };
      }),
    };
    render(<RunInspector bridge={bridge} runId={99} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText("Deploy"));
    await screen.findByText("Logs in progress");
    expect(screen.getByText(/Excerpt truncated at the 10,000-line/)).toBeTruthy();
  });
});

describe("run inspector background refresh", () => {
  const ACTIVE_RUN_REFRESH_MS = 10_000;
  const WAITING_RUN_REFRESH_MS = 30_000;
  const runAt = (status: string, stepStatus: string) => ({
    runId: 77, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
    title: "apply", status, conclusion: status === "completed" ? "success" : null,
    htmlUrl: "https://github.com/acme/demo/actions/runs/77",
    jobs: [{
      id: 5, runId: 77, attempt: 1, name: "Apply", status, conclusion: status === "completed" ? "success" : null,
      steps: [{ number: 3, name: "Terraform apply", status: stepStatus, conclusion: stepStatus === "completed" ? "success" : null }],
    }],
  });

  it("refreshes an active run, reloads the selected log once it finishes, then stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let current = runAt("in_progress", "in_progress");
      const request = vi.fn(async (operation: string) => operation === "run.inspect"
        ? current
        : { text: "apply log", truncated: false, availability: "loaded" });
      render(<RunInspector bridge={{ request }} runId={77} defaultRefreshSeconds={10} onClose={() => undefined} />);
      await screen.findAllByText("Terraform apply");
      const inspectCalls = () => request.mock.calls.filter(([operation]) => operation === "run.inspect").length;
      expect(inspectCalls()).toBe(1);

      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_REFRESH_MS);
      await waitFor(() => expect(inspectCalls()).toBe(2));

      fireEvent.click(screen.getAllByText("Terraform apply")[0]!);
      const logCalls = () => request.mock.calls.filter(([operation]) => operation === "run.logs.load").length;
      await waitFor(() => expect(logCalls()).toBeGreaterThan(0));
      const logsBeforeFinish = logCalls();

      current = runAt("completed", "completed");
      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_REFRESH_MS);
      await waitFor(() => expect(logCalls()).toBe(logsBeforeFinish + 1));
      const finalInspects = inspectCalls();

      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_REFRESH_MS * 3);
      expect(inspectCalls()).toBe(finalInspects);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh while the panel is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const request = vi.fn(async (operation: string) => operation === "run.inspect"
        ? runAt("waiting", "queued")
        : { runId: 77, environments: [] });
      render(<RunInspector bridge={{ request }} runId={77} onClose={() => undefined} />);
      await screen.findAllByText("Terraform apply");
      await vi.advanceTimersByTimeAsync(WAITING_RUN_REFRESH_MS * 3);
      expect(request.mock.calls.filter(([operation]) => operation === "run.inspect")).toHaveLength(1);
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("run inspector refresh interval", () => {
  const waitingRun = {
    runId: 88, attempt: 1, attemptCount: 1, dependencyResolution: "resolved",
    title: "deploy", status: "in_progress", conclusion: null,
    htmlUrl: "https://github.com/acme/demo/actions/runs/88",
    jobs: [{ id: 9, runId: 88, attempt: 1, name: "Deploy", status: "in_progress", conclusion: null, steps: [] }],
  };

  it("uses the configured default, lets the user change it, and saves a new default", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const request = vi.fn(async (operation: string, payload?: { seconds?: number }) => {
        if (operation === "run.inspect") return waitingRun;
        if (operation === "preferences.saveRunRefresh") return { seconds: payload?.seconds };
        return { text: "", truncated: false, availability: "loaded" };
      });
      render(<RunInspector bridge={{ request }} runId={88} defaultRefreshSeconds={45} onClose={() => undefined} />);
      const select = await screen.findByLabelText("Auto-refresh interval") as HTMLSelectElement;
      expect(select.value).toBe("45");
      expect(screen.getByRole("option", { name: "Refresh every 45s (default)" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Make default" })).toBeNull();
      const inspects = () => request.mock.calls.filter(([operation]) => operation === "run.inspect").length;

      fireEvent.change(select, { target: { value: "5" } });
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => expect(inspects()).toBe(2));

      fireEvent.click(screen.getByRole("button", { name: "Make default" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("preferences.saveRunRefresh", { seconds: 5 }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Make default" })).toBeNull());

      fireEvent.change(select, { target: { value: "0" } });
      const afterOff = inspects();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(inspects()).toBe(afterOff);
    } finally {
      vi.useRealTimers();
    }
  });
});
