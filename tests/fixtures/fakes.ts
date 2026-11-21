import type { WorkflowRunRecord } from "../../src/domain/models/run";
import type { LocalWorkflow, RemoteWorkflow } from "../../src/domain/models/workflow";

export class InMemoryStateStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

export function makeRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 1,
    workflowId: 1,
    attemptCount: 1,
    hydration: "summary",
    displayTitle: "Build",
    status: "completed",
    conclusion: "success",
    event: "push",
    branch: "main",
    headSha: "abc",
    actor: { id: 42, login: "roman" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    htmlUrl: "https://github.com/acme/demo/actions/runs/1",
    ...overrides,
  };
}

export function makeWorkflow(index: number, overrides: Partial<LocalWorkflow> = {}): LocalWorkflow {
  return {
    path: `.github/workflows/workflow-${index}.yml`,
    name: `workflow-${index}`,
    folder: index % 2 ? "CI" : "Deploy",
    dispatchable: true,
    ...overrides,
  };
}

export function makeRemoteWorkflow(index: number, overrides: Partial<RemoteWorkflow> = {}): RemoteWorkflow {
  return {
    id: index,
    path: `.github/workflows/workflow-${index}.yml`,
    name: `workflow-${index}`,
    state: "active",
    ...overrides,
  };
}
