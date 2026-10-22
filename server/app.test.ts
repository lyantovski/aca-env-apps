import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { makeTestApp, testConfig } from "./test-support.js";
import type { Session, Todo } from "../shared/types.js";

describe.sequential("Pocket Tasks API", () => {
  let context: Awaited<ReturnType<typeof makeTestApp>>;
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    context = await makeTestApp();
  });
  afterEach(async () => {
    if (context) { context.store.clear(); await context.db.pool.end(); }
    vi.restoreAllMocks();
  });

  async function login(name = "alice") {
    const agent = request.agent(context.app);
    const start = await agent.get("/auth/login").expect(302);
    const state = new URL(start.headers.location).searchParams.get("state");
    await agent.get("/auth/callback").query({ code: name, state }).expect(302).expect("Location", "/");
    const response = await agent.get("/api/session").expect(200);
    return { agent, session: response.body as Session };
  }

  function headers(token: string) { return { Origin: testConfig.APP_URL, "X-CSRF-Token": token }; }

  it("reports liveness/readiness and returns an anonymous session", async () => {
    await request(context.app).get("/health/live").expect(200, { status: "alive" });
    await request(context.app).get("/health/ready").expect(200, { status: "ready" });
    const response = await request(context.app).get("/api/session").expect(200);
    expect(response.body.user).toBeNull();
    expect(response.body.csrfToken).toHaveLength(64);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Lax");
  });

  it("denies unauthenticated reads and writes", async () => {
    const agent = request.agent(context.app);
    const response = await agent.get("/api/session").expect(200);
    await agent.get("/api/todos").expect(401);
    await agent.post("/api/todos").set(headers(response.body.csrfToken)).send({ title: "Not allowed" }).expect(401);
  });

  it("regenerates the session on sign-in and creates an account from verified identity", async () => {
    const { agent, session } = await login();
    expect(session.user).toMatchObject({ name: "Alice Example", email: "alice@example.test", theme: "light" });
    const before = await agent.get("/api/session");
    const attempt = await agent.get("/auth/login");
    const state = new URL(attempt.headers.location).searchParams.get("state");
    await agent.get("/auth/callback").query({ code: "alice", state }).expect(302);
    const after = await agent.get("/api/session");
    expect(before.body.csrfToken).not.toBe(after.body.csrfToken);
  });

  it("supports adding, editing, completing, reopening and deleting tasks", async () => {
    const { agent, session } = await login();
    const h = headers(session.csrfToken);
    const created = await agent.post("/api/todos").set(h).send({ title: "  First task  " }).expect(201);
    const todo = created.body as Todo;
    expect(todo.title).toBe("First task");
    expect(todo.completed).toBe(false);
    expect(todo.createdAt).toBeTruthy();
    await agent.patch(`/api/todos/${todo.id}`).set(h).send({ title: "Updated", completed: true }).expect(200);
    const list = await agent.get("/api/todos").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ title: "Updated", completed: true });
    const reopened = await agent.patch(`/api/todos/${todo.id}`).set(h).send({ completed: false }).expect(200);
    expect(reopened.body.completed).toBe(false);
    await agent.delete(`/api/todos/${todo.id}`).set(h).expect(204);
    await agent.get("/api/todos").expect(200, []);
    await agent.delete(`/api/todos/${todo.id}`).set(h).expect(404);
  });

  it("isolates task reads, edits and deletion by account", async () => {
    const alice = await login();
    const bob = await login("bob");
    const created = await alice.agent.post("/api/todos").set(headers(alice.session.csrfToken)).send({ title: "Private" }).expect(201);
    await bob.agent.get("/api/todos").expect(200, []);
    await bob.agent.patch(`/api/todos/${created.body.id}`).set(headers(bob.session.csrfToken)).send({ completed: true }).expect(404);
    await bob.agent.delete(`/api/todos/${created.body.id}`).set(headers(bob.session.csrfToken)).expect(404);
    const list = await alice.agent.get("/api/todos").expect(200);
    expect(list.body[0].title).toBe("Private");
  });

  it("rejects missing CSRF tokens and foreign origins", async () => {
    const { agent, session } = await login();
    await agent.post("/api/todos").send({ title: "No" }).expect(403);
    await agent.post("/api/todos").set({ ...headers(session.csrfToken), Origin: "https://other.example" }).send({ title: "No" }).expect(403);
    await agent.post("/auth/logout").expect(403);
    await agent.get("/api/todos").expect(200, []);
  });

  it("validates task titles, request shape, JSON, settings and task IDs", async () => {
    const { agent, session } = await login();
    const h = headers(session.csrfToken);
    for (const title of ["", "   ", "x".repeat(201)]) {
      await agent.post("/api/todos").set(h).send({ title }).expect(400);
    }
    await agent.post("/api/todos").set(h).send({ title: "x".repeat(200) }).expect(201);
    await agent.post("/api/todos").set(h).send({ title: "Valid", user_id: "other" }).expect(400);
    await agent.post("/api/todos").set(h).set("Content-Type", "application/json").send("{").expect(400);
    await agent.post("/api/todos").set(h).send({ title: "x".repeat(10000) }).expect(413);
    await agent.patch("/api/todos/not-a-uuid").set(h).send({ title: "No" }).expect(400);
    await agent.patch("/api/profile").set(h).send({ theme: "invalid" }).expect(400);
    const created = await agent.post("/api/todos").set(h).send({ title: "Task" });
    await agent.patch(`/api/todos/${created.body.id}`).set(h).send({}).expect(400);
    await agent.patch(`/api/todos/${created.body.id}`).set(h).send({ completed: "true" }).expect(400);
  });

  it("preserves appearance on subsequent sign-ins without changing another account", async () => {
    const alice = await login();
    await alice.agent.patch("/api/profile").set(headers(alice.session.csrfToken)).send({ theme: "dark" }).expect(200);
    const again = await login();
    expect(again.session.user?.theme).toBe("dark");
    const bob = await login("bob");
    expect(bob.session.user?.theme).toBe("light");
  });

  it("destroys the local session and returns the Microsoft logout URL", async () => {
    const { agent, session } = await login();
    const result = await agent.post("/auth/logout").set(headers(session.csrfToken)).expect(200);
    expect(result.body.redirectUrl).toBe("https://login.example.test/logout");
    await agent.get("/api/todos").expect(401);
    const current = await agent.get("/api/session");
    expect(current.body.user).toBeNull();
    expect(current.body.csrfToken).not.toBe(session.csrfToken);
  });

  it("rejects invalid, replayed, expired and cancelled login callbacks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = request.agent(context.app);
    await agent.get("/auth/callback").query({ code: "alice", state: "unknown" }).expect("Location", "/?authError=invalid_state");
    const start = await agent.get("/auth/login");
    const state = new URL(start.headers.location).searchParams.get("state");
    await agent.get("/auth/callback").query({ state, error: "access_denied" }).expect("Location", "/?authError=signin_cancelled");
    await agent.get("/auth/callback").query({ code: "alice", state }).expect("Location", "/?authError=invalid_state");
    const expired = await agent.get("/auth/login");
    const expiredState = new URL(expired.headers.location).searchParams.get("state");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    await agent.get("/auth/callback").query({ code: "alice", state: expiredState }).expect("Location", "/?authError=invalid_state");
    expect((await agent.get("/api/session")).body.user).toBeNull();
  });

  it("shows a sign-in failure without exposing provider errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = request.agent(context.app);
    const start = await agent.get("/auth/login");
    const state = new URL(start.headers.location).searchParams.get("state");
    await agent.get("/auth/callback").query({ code: "fail", state }).expect("Location", "/?authError=signin_failed");
    expect((await agent.get("/api/session")).body.user).toBeNull();
  });

  it("surfaces database failures and reports not ready", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent } = await login();
    vi.spyOn(context.db.pool, "query").mockRejectedValue(new Error("Database unavailable"));
    await agent.get("/api/todos").expect(500, { error: "Something went wrong on the server. Please try again." });
    await agent.get("/health/ready").expect(503, { error: "Database is unavailable." });
    await agent.get("/health/live").expect(200);
  });
});
