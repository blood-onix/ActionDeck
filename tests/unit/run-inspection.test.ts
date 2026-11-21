import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectRun, loadJobLogProjection } from "../../src/application/runs/inspection-service";
import { AppError } from "../../src/domain/models/errors";
import { loadJobLog } from "../../src/github/repositories/job-repository";
import { boundLogExcerpt, MAX_LOG_BYTES } from "../../src/domain/services/log-bounds";

afterEach(() => vi.unstubAllGlobals());

describe("run inspection", () => {
  function fakeClient(attempt: number) {
    return {
      getRun: vi.fn().mockResolvedValue({
        id: 19,
        run_number: 8,
        run_attempt: 3,
        display_title: "resolved title",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/demo/actions/runs/19",
      }),
      listJobs: vi.fn().mockResolvedValue({
        total_count: 1,
        jobs: [{
          id: attempt * 10,
          run_id: 19,
          name: `attempt-${attempt}`,
          status: "completed",
          conclusion: "failure",
          runner_name: "Hosted",
          started_at: "2026-11-14T00:00:00Z",
          completed_at: "2026-11-14T00:01:00Z",
          steps: [{ number: 1, name: "Build", status: "completed", conclusion: "failure", started_at: null, completed_at: null }],
        }],
      }),
    };
  }

  it("returns only jobs and steps for the selected attempt", async () => {
    const client = fakeClient(2);
    const controller = new AbortController();
    const inspection = await inspectRun(client, 19, 2, controller.signal);
    expect(inspection.attempt).toBe(2);
    expect(inspection.attemptCount).toBe(3);
    expect(inspection.hydration).toBe("jobs_loaded");
    expect(inspection.jobs[0]?.name).toBe("attempt-2");
    expect(client.getRun).toHaveBeenCalledWith(19, controller.signal);
    expect(client.listJobs).toHaveBeenCalledWith(19, 2, controller.signal);
  });

  it("resolves job dependencies from the workflow file at the run revision", async () => {
    const client = fakeClient(2);
    client.getRun.mockResolvedValue({
      id: 19,
      run_number: 8,
      run_attempt: 3,
      display_title: "resolved title",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/acme/demo/actions/runs/19",
      path: "acme/demo/.github/workflows/ci.yml@refs/heads/main",
      head_sha: "a".repeat(40),
    });
    client.listJobs.mockResolvedValue({
      total_count: 2,
      jobs: [
        { id: 20, run_id: 19, name: "build", status: "completed", conclusion: "success" },
        { id: 21, run_id: 19, name: "test", status: "completed", conclusion: "failure" },
      ],
    });
    const getWorkflowSource = vi.fn().mockResolvedValue(`
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest
`);
    const inspection = await inspectRun({ ...client, getWorkflowSource }, 19, 2);

    expect(getWorkflowSource).toHaveBeenCalledWith(
      ".github/workflows/ci.yml",
      "a".repeat(40),
      undefined,
    );
    expect(inspection.dependencyResolution).toBe("resolved");
    expect(inspection.jobs[0]?.needs).toEqual([]);
    expect(inspection.jobs[1]?.needs).toEqual(["build"]);
  });

  it("keeps a flat job list when the run revision or dependency relationships cannot be resolved", async () => {
    const client = fakeClient(2);
    client.getRun.mockResolvedValue({
      id: 19,
      run_number: 8,
      run_attempt: 3,
      display_title: "resolved title",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/acme/demo/actions/runs/19",
      path: "acme/demo/.github/workflows/ci.yml@refs/heads/main",
      head_sha: "a".repeat(40),
    });
    const getWorkflowSource = vi.fn().mockResolvedValue("jobs: [");
    const inspection = await inspectRun({ ...client, getWorkflowSource }, 19, 2);

    expect(inspection.dependencyResolution).toBe("unresolved");
    expect(inspection.jobs[0]?.name).toBe("attempt-2");
    expect(inspection.jobs[0]).not.toHaveProperty("needs");
  });

  it("rejects attempts outside the run's actual range without fetching jobs", async () => {
    const client = fakeClient(0);
    await expect(inspectRun(client, 19, 4))
      .rejects.toThrow("Requested run attempt is not available");
    expect(client.listJobs).not.toHaveBeenCalled();
  });

  it("uses only the HTTPS GitHub blob redirect and caps streamed log downloads", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "https://logs.blob.core.windows.net/actiondeck/run.txt?sig=temporary" },
      data: "",
    });
    const client = {
      rest: { actions: {} },
      request,
    };
    const fetch = vi.fn().mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a".repeat(MAX_LOG_BYTES + 32)));
          controller.close();
        },
      }),
    ));
    vi.stubGlobal("fetch", fetch);
    const text = await loadJobLog(client, { owner: "acme", repo: "demo" }, 70);
    expect(text.startsWith("[ActionDeck: log truncated at 2 MB]")).toBe(true);
    expect(text.length).toBeLessThan(MAX_LOG_BYTES + 100);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "logs.blob.core.windows.net" }),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
      expect.objectContaining({
        owner: "acme", repo: "demo", job_id: 70,
        request: { redirect: "manual", retries: 1, retryAfter: 0.01 },
      }),
    );
  });

  it("rejects log redirects to untrusted hosts without fetching them", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "https://evil.example/log.txt" },
      data: "",
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(loadJobLog({ rest: { actions: {} }, request }, { owner: "acme", repo: "demo" }, 70))
      .rejects.toThrow("unsupported job log download host");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never calls a step-specific log endpoint and rejects invalid job IDs", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: "whole job" });
    const text = await loadJobLog({ rest: { actions: {} }, request }, { owner: "acme", repo: "demo" }, 70);
    expect(text).toBe("whole job");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs");
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("step_number");
    await expect(loadJobLog({ rest: { actions: {} }, request }, { owner: "acme", repo: "demo" }, 0))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("projects expired, restricted, and unavailable job logs without throwing or fabricating text", async () => {
    const job = {
      id: 70, runId: 55, attempt: 1, name: "build", status: "completed", conclusion: "failure", steps: [],
      logAvailability: "not_loaded" as const,
    };
    const failing = (error: unknown) => ({ loadLog: vi.fn().mockRejectedValue(error) });
    expect(await loadJobLogProjection(failing({ status: 410 }), job))
      .toMatchObject({ availability: "expired", text: "", truncated: false });
    expect(await loadJobLogProjection(failing({ status: 403 }), job))
      .toMatchObject({ availability: "restricted", text: "" });
    expect(await loadJobLogProjection(failing(new AppError("authentication_required", "sign in")), job))
      .toMatchObject({ availability: "restricted" });
    expect(await loadJobLogProjection(failing({ status: 404 }), job))
      .toMatchObject({ availability: "unavailable", message: expect.stringContaining("did not provide") });
    expect(await loadJobLogProjection(failing({ status: 404 }), { ...job, status: "in_progress" }))
      .toMatchObject({ availability: "unavailable", message: expect.stringContaining("not finished") });
    await expect(loadJobLogProjection(failing({ status: 429 }), job)).rejects.toBeDefined();
  });

  it("returns only a step section when its timestamps are unambiguous and otherwise the full log with an explanation", async () => {
    const log = [
      "2026-11-14T10:00:00.1000000Z setup",
      "2026-11-14T10:00:05.1000000Z build line one",
      "2026-11-14T10:00:06.9000000Z build line two",
      "2026-11-14T10:00:10.1000000Z test line",
    ].join("\n");
    const job = {
      id: 70, runId: 55, attempt: 1, name: "build", status: "completed", conclusion: "success",
      steps: [
        { number: 1, name: "Set up", status: "completed", conclusion: "success", startedAt: "2026-11-14T10:00:00Z", completedAt: "2026-11-14T10:00:00Z" },
        { number: 2, name: "Build", status: "completed", conclusion: "success", startedAt: "2026-11-14T10:00:05Z", completedAt: "2026-11-14T10:00:06Z" },
        { number: 3, name: "Test", status: "completed", conclusion: "success", startedAt: "2026-11-14T10:00:10Z", completedAt: "2026-11-14T10:00:10Z" },
      ],
      logAvailability: "not_loaded" as const,
    };
    const repository = { loadLog: vi.fn().mockResolvedValue(log) };
    const step = await loadJobLogProjection(repository, job, 2);
    expect(step).toMatchObject({ availability: "loaded", stepNumber: 2, stepBoundary: "identified" });
    expect(step.text).toContain("build line one");
    expect(step.text).not.toContain("setup");
    expect(step.text).not.toContain("test line");
    expect(repository.loadLog).toHaveBeenCalledWith(55, 1, 70, undefined);

    const ambiguous = await loadJobLogProjection(repository, {
      ...job,
      steps: job.steps.map((s) => s.number === 3 ? { ...s, startedAt: "2026-11-14T10:00:06Z" } : s),
    }, 2);
    expect(ambiguous.stepBoundary).toBe("unidentified");
    expect(ambiguous.text).toContain("test line");
    expect(ambiguous.message).toContain("full job log");

    const whole = await loadJobLogProjection(repository, job);
    expect(whole).not.toHaveProperty("stepBoundary");
    await expect(loadJobLogProjection(repository, job, 9)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("decodes binary-heavy log bytes and removes embedded control characters", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "https://logs.blob.core.windows.net/actiondeck/run.txt" },
      data: "",
    });
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff, 0x00, 0x41])));
    vi.stubGlobal("fetch", fetch);
    const raw = await loadJobLog({ rest: { actions: {} }, request }, { owner: "acme", repo: "demo" }, 70);
    const excerpt = boundLogExcerpt(70, 1, raw);
    expect(excerpt.text).toBe("�A");
    expect(excerpt.text).not.toContain("\u0000");
  });
});
