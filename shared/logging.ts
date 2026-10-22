export const clientActions = [
  "session.load", "todos.list", "todos.create", "todos.update", "todos.delete",
  "profile.update", "auth.logout",
] as const;

export type ClientAction = typeof clientActions[number];

export function isClientAction(value: unknown): value is ClientAction {
  return typeof value === "string" && clientActions.some((action) => action === value);
}

export function logPath(path: string): string {
  return path.split(/[?#]/, 1)[0].slice(0, 256);
}

export function clientActionFor(method: string, path: string): ClientAction | undefined {
  const pathname = logPath(path);
  if (method === "GET" && pathname === "/api/session") return "session.load";
  if (method === "GET" && pathname === "/api/todos") return "todos.list";
  if (method === "POST" && pathname === "/api/todos") return "todos.create";
  if (method === "PATCH" && /^\/api\/todos\/[^/]+$/.test(pathname)) return "todos.update";
  if (method === "DELETE" && /^\/api\/todos\/[^/]+$/.test(pathname)) return "todos.delete";
  if (method === "PATCH" && pathname === "/api/profile") return "profile.update";
  if (method === "POST" && pathname === "/auth/logout") return "auth.logout";
  return undefined;
}
