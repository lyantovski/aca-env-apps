import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RequestHandler } from "express";
import { clientActionFor, isClientAction, logPath, type ClientAction } from "../shared/logging.js";

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  clientAction?: ClientAction;
}

type LogFields = Record<string, string | number | boolean | null | undefined>;
export const requestContext = new AsyncLocalStorage<RequestContext | undefined>();

export function log(
  level: "info" | "warn" | "error",
  layer: "frontend" | "backend" | "database" | "runtime",
  event: string,
  fields: LogFields = {},
) {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(), service: "pocket-tasks",
    level, layer, event, ...fields, ...requestContext.getStore(),
  }));
}

export function errorFields(error: unknown): LogFields {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
    errorCode: typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z]{2,30})$/.test(code) ? code : undefined,
  };
}

function duration(start: number) {
  return Math.round((performance.now() - start) * 100) / 100;
}

export const requestLogging: RequestHandler = (req, res, next) => {
  const suppliedId = req.get("X-Request-ID");
  const action = req.get("X-Client-Action");
  const context: RequestContext = {
    requestId: suppliedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedId)
      ? suppliedId.toLowerCase() : randomUUID(),
    method: req.method,
    path: logPath(req.originalUrl),
    ...(isClientAction(action) && clientActionFor(req.method, req.originalUrl) === action ? { clientAction: action } : {}),
  };
  res.setHeader("X-Request-ID", context.requestId);
  const start = performance.now();
  requestContext.run(context, () => {
    if (context.clientAction) {
      log("info", "frontend", "frontend.request.received", { source: "client-action-header" });
    }
    log("info", "backend", "http.request.started");
    res.once("finish", () => requestContext.run(context, () => {
      log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "backend",
        "http.request.completed", { status: res.statusCode, durationMs: duration(start) });
    }));
    res.once("close", () => {
      if (!res.writableFinished) {
        requestContext.run(context, () => log("warn", "backend", "http.request.aborted", { durationMs: duration(start) }));
      }
    });
    next();
  });
};

function startDatabaseOperation(operation: string) {
  const context = requestContext.getStore();
  const start = performance.now();
  const spanId = randomUUID();
  let finished = false;
  log("info", "database", "db.operation.started", { operation, spanId });
  return (error?: unknown, result?: unknown) => {
    if (finished) return;
    finished = true;
    const rowCount = result && typeof result === "object" && "rowCount" in result ? result.rowCount : undefined;
    requestContext.run(context, () => {
      log(error ? "error" : "info", "database", error ? "db.operation.failed" : "db.operation.completed", {
        operation, spanId, durationMs: duration(start),
        rowCount: typeof rowCount === "number" ? rowCount : undefined,
        ...(error ? errorFields(error) : {}),
      });
    });
  };
}

export async function traceDatabase<T>(operation: string, execute: () => Promise<T>): Promise<T> {
  const finish = startDatabaseOperation(operation);
  try {
    const result = await execute();
    finish(undefined, result);
    return result;
  } catch (error) {
    finish(error);
    throw error;
  }
}

export function traceDatabaseCallback<Args extends unknown[]>(
  operation: string,
  execute: (complete: (error: unknown, ...args: Args) => void) => void,
  callback: (error: unknown, ...args: Args) => void,
) {
  const context = requestContext.getStore();
  const finish = startDatabaseOperation(operation);
  try {
    execute((error, ...args) => {
      requestContext.run(context, () => {
        finish(error);
        callback(error, ...args);
      });
    });
  } catch (error) {
    finish(error);
    throw error;
  }
}
