import { eventSchema, responseSchema, type HostEvent, type HostOperation } from "../../src/protocol/envelopes";

export interface Bridge {
  request<T>(operation: HostOperation, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  onEvent?(event: string, listener: (event: HostEvent) => void): () => void;
}

export class BridgeError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) {
    super(message);
    this.name = "BridgeError";
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
let bridge: Bridge | undefined;
let listening = false;
const pending = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}>();
const eventListeners = new Map<string, Set<(event: HostEvent) => void>>();

export interface PersistedWebviewUiState {
  drawerWidthPx?: number;
}

const memoryUiState: Record<string, unknown> = {};

function getVsCodeApiOptional(): VsCodeApi | undefined {
  if (api) return api;
  try {
    if (typeof acquireVsCodeApi === "function") {
      api = acquireVsCodeApi();
      return api;
    }
  } catch {
    // JSDOM or non-webview test environment
  }
  return undefined;
}

export function getWebviewState<T extends object = PersistedWebviewUiState>(): T {
  const vscodeApi = getVsCodeApiOptional();
  if (vscodeApi) {
    const raw = vscodeApi.getState();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as T;
    }
    return {} as T;
  }
  return { ...memoryUiState } as T;
}

export function setWebviewState<T extends object = PersistedWebviewUiState>(
  patch: Partial<T>,
): T {
  const current = getWebviewState<T>();
  const next = { ...current, ...patch } as T;
  const vscodeApi = getVsCodeApiOptional();
  if (vscodeApi) {
    vscodeApi.setState(next);
  } else {
    Object.assign(memoryUiState, patch);
  }
  return next;
}

export function createBridge(): Bridge {
  if (!api) {
    api = acquireVsCodeApi();
  }
  if (bridge) return bridge;
  const vscodeApi = api;
  if (!vscodeApi) throw new Error("VS Code webview API is unavailable.");

  const receive = (event: MessageEvent<unknown>) => {
    const parsed = responseSchema.safeParse(event.data);
    if (parsed.success) {
      const waiter = pending.get(parsed.data.requestId);
      if (!waiter) return;
      pending.delete(parsed.data.requestId);
      clearTimeout(waiter.timer);
      waiter.cleanup();
      if (parsed.data.ok) {
        waiter.resolve(parsed.data.data);
      } else {
        waiter.reject(new BridgeError(
          parsed.data.error.message,
          parsed.data.error.code,
          parsed.data.error.retryable,
        ));
      }
      return;
    }

    const hostEvent = eventSchema.safeParse(event.data);
    if (!hostEvent.success) return;
    for (const listener of eventListeners.get(hostEvent.data.event) ?? []) {
      try {
        listener(hostEvent.data);
      } catch (reason) {
        console.error("ActionDeck event listener failed", reason);
      }
    }
  };
  if (!listening) {
    window.addEventListener("message", receive);
    listening = true;
  }

  bridge = {
    request<T>(operation: HostOperation, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      const requestId = globalThis.crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("ActionDeck request was cancelled."));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(requestId);
          signal?.removeEventListener("abort", cancel);
          reject(new Error("ActionDeck request timed out."));
        }, 60_000);
        const cancel = () => {
          pending.delete(requestId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          try {
            vscodeApi.postMessage({ version: 1, type: "cancel", requestId });
          } catch (reason) {
            console.error("Could not send ActionDeck cancellation", reason);
          } finally {
            reject(new Error("ActionDeck request was cancelled."));
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        pending.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
          cleanup: () => signal?.removeEventListener("abort", cancel),
        });
        try {
          vscodeApi.postMessage({ version: 1, type: "request", requestId, operation, payload });
        } catch (reason) {
          pending.delete(requestId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          reject(reason instanceof Error ? reason : new Error("Could not send ActionDeck request."));
        }
      });
    },
    onEvent(event: string, listener: (event: HostEvent) => void): () => void {
      const listeners = eventListeners.get(event) ?? new Set();
      listeners.add(listener);
      eventListeners.set(event, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventListeners.delete(event);
      };
    },
  };
  return bridge;
}
