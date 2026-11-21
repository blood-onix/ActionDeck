import { AppError } from "../domain/models/errors";
import { redactSensitiveText } from "../domain/services/redaction";

export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

const repositoryPrefix = "actiondeck.v1:repository:";
const preferencePrefix = "actiondeck.v1:preferences:";
const sensitiveField = /(?:token|password|secret|authorization|(?:^|[_-])key$|(?:^|[_-])logs?(?:$|[_-])|(?:job|step)logs?(?:text)?$)/i;
const camelCaseKeyField = /Key$/;

export class RepositoryState {
  constructor(private readonly state: StateStore, private readonly repositoryId: string) {}

  get<T>(key: string): T | undefined {
    return this.state.get<T>(`${repositoryPrefix}${this.repositoryId}:${key}`);
  }

  update(key: string, value: unknown): Promise<void> {
    assertPersistable(value, key);
    return this.state.update(`${repositoryPrefix}${this.repositoryId}:${key}`, value);
  }
}

export class GlobalPreferences {
  constructor(private readonly state: StateStore) {}

  get<T>(key: string): T | undefined {
    return this.state.get<T>(`${preferencePrefix}${key}`);
  }

  update(key: string, value: unknown): Promise<void> {
    assertPersistable(value, key);
    return this.state.update(`${preferencePrefix}${key}`, value);
  }
}

function assertPersistable(value: unknown, rootKey: string): void {
  const seen = new WeakSet<object>();
  const inspect = (item: unknown, key?: string): void => {
    if (key && (sensitiveField.test(key) || camelCaseKeyField.test(key))) {
      throw new AppError("invalid_input", "Authentication data and log content cannot be persisted.");
    }
    if (typeof item === "string") {
      if (redactSensitiveText(item) !== item) {
        throw new AppError("invalid_input", "Values containing credential assignments cannot be persisted.");
      }
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new AppError("invalid_input", "Non-finite state values cannot be persisted.");
      return;
    }
    if (typeof item !== "object") {
      if (typeof item !== "string") {
        throw new AppError("invalid_input", "State values must contain only JSON-compatible data.");
      }
      return;
    }
    if (seen.has(item)) throw new AppError("invalid_input", "Circular state values cannot be persisted.");
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) inspect(child);
    } else {
      for (const [childKey, child] of Object.entries(item)) inspect(child, childKey);
    }
    seen.delete(item);
  };
  inspect(value, rootKey);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 512 * 1024) {
    throw new AppError("invalid_input", "State values must be JSON serializable and no larger than 512 KiB.");
  }
}
