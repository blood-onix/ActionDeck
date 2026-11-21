import * as vscode from "vscode";
import { cancelRequestSchema, errorResponse, successResponse, validateRequest } from "../../protocol/envelopes";
import { AppError } from "../../domain/models/errors";

export type OperationHandler = (payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

export function routeMessages(
  panel: vscode.WebviewPanel,
  handlers: Record<string, OperationHandler>,
  disposables: vscode.Disposable[],
) {
  let disposed = false;
  const active = new Map<string, AbortController>();
  const seenRequestIds = new Set<string>();
  const requestOrder: string[] = [];
  const rememberRequestId = (requestId: string) => {
    seenRequestIds.add(requestId);
    requestOrder.push(requestId);
    if (requestOrder.length > 4_096) {
      const expired = requestOrder.shift();
      if (expired) seenRequestIds.delete(expired);
    }
  };
  const registration = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const cancellation = cancelRequestSchema.safeParse(raw);
    if (cancellation.success) {
      active.get(cancellation.data.requestId)?.abort();
      return;
    }
    const rawRecord = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const rawRequestId = typeof rawRecord.requestId === "string" && rawRecord.requestId.length > 0 &&
      rawRecord.requestId.length <= 128 ? rawRecord.requestId : undefined;
    if (rawRequestId && seenRequestIds.has(rawRequestId)) return;
    const parsed = validateRequest(raw);
    if (!parsed.success) {
      if (rawRequestId) {
        rememberRequestId(rawRequestId);
        await panel.webview.postMessage(errorResponse(rawRequestId, {
          code: "invalid_input",
          message: "Invalid or oversized ActionDeck request.",
          retryable: false,
        }));
      }
      return;
    }
    const request = parsed.data;
    if (seenRequestIds.has(request.requestId)) return;
    rememberRequestId(request.requestId);
    const controller = new AbortController();
    active.set(request.requestId, controller);
    let response: ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>;
    try {
      const handler = handlers[request.operation];
      if (!handler) throw new AppError("invalid_input", "Unsupported operation");
      const data = await handler(request.payload as Record<string, unknown>, controller.signal);
      if (controller.signal.aborted) throw new AppError("cancelled", "ActionDeck request was cancelled.");
      response = successResponse(request.requestId, data);
    } catch (error) {
      if (!(error instanceof AppError)) console.error("ActionDeck request failed", error);
      const appError = error instanceof AppError ? error : new AppError("service", "ActionDeck could not complete the request.");
      response = errorResponse(request.requestId, {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
      });
    } finally {
      active.delete(request.requestId);
    }
    if (!disposed) {
      try {
        await panel.webview.postMessage(response);
      } catch (error) {
        console.error("ActionDeck could not post a response to the webview", error);
      }
    }
  });
  disposables.push(registration, new vscode.Disposable(() => {
    disposed = true;
    for (const controller of active.values()) controller.abort();
    active.clear();
  }));
}
