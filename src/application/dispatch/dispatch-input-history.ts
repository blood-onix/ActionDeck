import type { RepositoryState } from "../../persistence/workspace-state";

const DISPATCH_INPUTS_KEY = "dispatchInputs";
export const MAX_STORED_DISPATCH_INPUTS = 200;

export interface RecordedDispatchInputs {
  readonly ref: string;
  /** Name/value pairs, so input names never become state keys the credential guard would refuse. */
  readonly inputs: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly recordedAt: number;
}

/**
 * GitHub does not return workflow_dispatch inputs for a run, so ActionDeck keeps the ones it sent,
 * per repository, for the most recent runs.
 */
export class DispatchInputHistory {
  constructor(private readonly state: RepositoryState, private readonly now: () => number = Date.now) {}

  get(runId: number): RecordedDispatchInputs | undefined {
    return this.readAll()[String(runId)];
  }

  /** Returns false when the state store refuses the values (for example credential-like text). */
  async record(runId: number, ref: string, inputs: Readonly<Record<string, string>>): Promise<boolean> {
    const all = this.readAll();
    all[String(runId)] = {
      ref,
      inputs: Object.entries(inputs).map(([name, value]) => ({ name, value })),
      recordedAt: this.now(),
    };
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => b.recordedAt - a.recordedAt)
      .slice(0, MAX_STORED_DISPATCH_INPUTS);
    try {
      await this.state.update(DISPATCH_INPUTS_KEY, Object.fromEntries(kept));
      return true;
    } catch {
      return false;
    }
  }

  private readAll(): Record<string, RecordedDispatchInputs> {
    const raw = this.state.get<unknown>(DISPATCH_INPUTS_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result: Record<string, RecordedDispatchInputs> = {};
    for (const [runId, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const { ref, inputs, recordedAt } = entry as Partial<RecordedDispatchInputs>;
      if (typeof ref !== "string" || typeof recordedAt !== "number" || !Array.isArray(inputs)) continue;
      if (!inputs.every((input) => typeof input?.name === "string" && typeof input?.value === "string")) continue;
      result[runId] = { ref, inputs, recordedAt };
    }
    return result;
  }
}
