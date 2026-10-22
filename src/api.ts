export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function request<T>(path: string, init?: RequestInit, csrfToken?: string): Promise<T> {
  const requestId = crypto.randomUUID();
  const method = (init?.method ?? "GET").toUpperCase();
  const clientAction = clientActionFor(method, path);
  const headers = new Headers(init?.headers);
  headers.set("X-Request-ID", requestId);
  if (clientAction) headers.set("X-Client-Action", clientAction);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const start = performance.now();
  const fields = { requestId, method, path: logPath(path), clientAction };
  const write = (event: string, level: string, status?: number, serverRequestId?: string | null) => {
    console.info(JSON.stringify({
      timestamp: new Date().toISOString(), service: "pocket-tasks", layer: "frontend",
      level, event, ...fields, status, serverRequestId,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    }));
  };
  write("frontend.request.started", "info");
  let response: Response | undefined;
  try {
    response = await fetch(path, { ...init, method, credentials: "same-origin", headers });
    if (!response.ok) {
      const data: unknown = await response.json();
      const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error : `Request failed (${response.status}).`;
      throw new ApiError(message, response.status);
    }
    const result: T = response.status === 204 ? undefined as T : await response.json();
    write("frontend.request.completed", "info", response.status, response.headers.get("X-Request-ID"));
    return result;
  } catch (error) {
    write("frontend.request.failed", response && !response.ok && response.status < 500 ? "warn" : "error",
      response?.status, response?.headers.get("X-Request-ID"));
    throw error;
  }
}
import { clientActionFor, logPath } from "../shared/logging";
