import { randomUUID } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { makeTestApp, testConfig, TestAuth } from "./test-support.js";
import { log, requestContext, requestLogging, traceDatabase, traceDatabaseCallback } from "./logging.js";
import { LoggedSessionStore } from "./session-store.js";
import { createApp } from "./app.js";

describe.sequential("correlated application logging", () => {
  let context: Awaited<ReturnType<typeof makeTestApp>>;
  let lines: string[];

  function records() {
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeEach(async () => {
    lines = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
    context = await makeTestApp();
    lines = [];
  });
  afterEach(async () => {
    if (context) { context.store.clear(); await context.db.pool.end(); }
    vi.restoreAllMocks();
  });

  async function signIn(app = context.app) {
    const agent = request.agent(app);
    const start = await agent.get("/auth/login").expect(302);
    const state = new URL(start.headers.location).searchParams.get("state");
    await agent.get("/auth/callback").query({ code: "alice", state }).expect(302);
    const session = await agent.get("/api/session").expect(200);
    return { agent, csrf: session.body.csrfToken as string };
  }

  it("logs every request, including assets, probes, malformed bodies and 404s, with a response ID", async () => {
    for (const path of ["/", "/favicon.svg", "/health/live", "/health/ready", "/not-found"]) {
      const response = await request(context.app).get(path);
      const requestId = response.headers["x-request-id"];
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const entries = records().filter((entry) => entry.requestId === requestId);
      expect(entries[0]).toMatchObject({ event: "http.request.started", method: "GET", path });
      expect(entries.at(-1)).toMatchObject({ event: "http.request.completed", status: response.status });
      expect(entries.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
    }
    const response = await request(context.app).post("/api/todos").set("Content-Type", "application/json").send("{").expect(400);
    expect(records().filter((entry) => entry.requestId === response.headers["x-request-id"]))
      .toContainEqual(expect.objectContaining({ event: "http.request.rejected", reason: "invalid_json" }));
  });

  it("connects frontend context, backend processing and actual database operations without logging data", async () => {
    const { agent, csrf } = await signIn();
    lines = [];
    const id = randomUUID();
    const secret = "private-task-content-never-log";
    await agent.post("/api/todos").set({
      Origin: testConfig.APP_URL, "X-CSRF-Token": csrf,
      "X-Request-ID": id, "X-Client-Action": "todos.create",
      Authorization: "Bearer never-log-access-token",
    }).send({ title: secret }).expect(201).expect("X-Request-ID", id);
    const entries = records();
    expect(entries.every((entry) => entry.requestId === id)).toBe(true);
    expect(entries[0]).toMatchObject({ layer: "frontend", event: "frontend.request.received", clientAction: "todos.create" });
    expect(entries[1]).toMatchObject({ layer: "backend", event: "http.request.started" });
    const dbStart = entries.find((entry) => entry.event === "db.operation.started" && entry.operation === "todos.create");
    const dbEnd = entries.find((entry) => entry.event === "db.operation.completed" && entry.operation === "todos.create");
    expect(dbStart).toBeDefined();
    expect(dbEnd).toMatchObject({ spanId: dbStart?.spanId, requestId: id, rowCount: 1 });
    expect(dbEnd?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entries.at(-1)).toMatchObject({ event: "http.request.completed", status: 201 });
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(csrf);
    expect(lines.join("\n")).not.toContain("never-log-access-token");
    expect(lines.join("\n")).not.toContain("INSERT INTO");
    expect(lines.join("\n")).not.toContain("alice@example.test");
  });

  it("excludes auth query parameters, cookies and untrusted correlation/action values", async () => {
    const sensitive = "sensitive-value-that-must-not-appear";
    const response = await request(context.app).get(`/auth/callback?code=${sensitive}&state=${sensitive}`)
      .set({ Cookie: `pocket.sid=${sensitive}`, "X-Request-ID": sensitive, "X-Client-Action": sensitive }).expect(302);
    expect(response.headers["x-request-id"]).not.toBe(sensitive);
    expect(lines.join("\n")).not.toContain(sensitive);
    expect(records()).toContainEqual(expect.objectContaining({ path: "/auth/callback", event: "auth.signin.rejected" }));
    lines = [];
    await request(context.app).get("/api/session").set("X-Client-Action", "todos.delete").expect(200);
    expect(records().some((entry) => entry.clientAction)).toBe(false);
  });

  it("reports database failures and HTTP failures with the same ID and no raw error details", async () => {
    const { agent } = await signIn();
    lines = [];
    const secret = "sensitive-error-detail";
    vi.spyOn(context.db.pool, "query").mockRejectedValue(Object.assign(new Error(secret), { code: "08006", detail: secret }));
    const id = randomUUID();
    await agent.get("/api/todos").set("X-Request-ID", id).expect(500);
    expect(records()).toContainEqual(expect.objectContaining({
      requestId: id, event: "db.operation.failed", operation: "users.read", errorCode: "08006", level: "error",
    }));
    expect(records()).toContainEqual(expect.objectContaining({ requestId: id, event: "http.request.completed", status: 500 }));
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("keeps concurrent operations and callbacks tied to their original request contexts", async () => {
    const first = { requestId: randomUUID(), method: "GET", path: "/first" };
    const second = { requestId: randomUUID(), method: "GET", path: "/second" };
    await Promise.all([
      requestContext.run(first, () => traceDatabase("first", () => new Promise((resolve) => setTimeout(() => resolve(1), 15)))),
      requestContext.run(second, () => traceDatabase("second", () => Promise.resolve(2))),
    ]);
    expect(records().filter((entry) => entry.operation === "first").every((entry) => entry.requestId === first.requestId)).toBe(true);
    expect(records().filter((entry) => entry.operation === "second").every((entry) => entry.requestId === second.requestId)).toBe(true);
    let complete: ((error: unknown) => void) | undefined;
    requestContext.run(first, () => traceDatabaseCallback("callback",
      (done) => { complete = done; }, () => log("info", "backend", "callback.continued")));
    requestContext.run(second, () => complete?.(undefined));
    expect(records().find((entry) => entry.event === "callback.continued")?.requestId).toBe(first.requestId);
    expect(records().find((entry) => entry.operation === "callback" && entry.event === "db.operation.completed")?.requestId).toBe(first.requestId);
  });

  it("records an aborted response rather than a successful completion", async () => {
    const app = express();
    app.use(requestLogging);
    app.get("/abort", (_req, res) => { res.write("partial response"); });
    const server = app.listen(0);
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test listener.");
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ port: address.port, path: "/abort" }, (response) => {
          response.once("data", () => { response.destroy(); resolve(); });
        });
        req.once("error", reject);
      });
      await vi.waitFor(() => expect(records()).toContainEqual(expect.objectContaining({ event: "http.request.aborted", path: "/abort" })));
      expect(records().some((entry) => entry.event === "http.request.completed")).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))("traces real PostgreSQL session reads, writes, touches and deletion", async () => {
    const store = new LoggedSessionStore(context.db.pool);
    try {
      const app = createApp(testConfig, context.db, new TestAuth(), store);
      const { agent, csrf } = await signIn(app);
      expect(records()).toContainEqual(expect.objectContaining({ operation: "sessions.write", event: "db.operation.completed" }));
      lines = [];
      const readId = randomUUID();
      await agent.get("/api/todos").set("X-Request-ID", readId).expect(200);
      for (const operation of ["sessions.read", "sessions.touch"]) {
        expect(records()).toContainEqual(expect.objectContaining({ requestId: readId, operation, event: "db.operation.completed" }));
      }
      const logoutId = randomUUID();
      await agent.post("/auth/logout").set({
        Origin: testConfig.APP_URL, "X-CSRF-Token": csrf, "X-Request-ID": logoutId,
      }).expect(200);
      expect(records()).toContainEqual(expect.objectContaining({ requestId: logoutId, operation: "sessions.delete", event: "db.operation.completed" }));
    } finally { await store.close(); }
  });
});
