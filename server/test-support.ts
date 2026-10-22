import pg from "pg";
import { DataType, newDb } from "pg-mem";
import session from "express-session";
import type { AuthProvider, LoginAttempt } from "./auth.js";
import { Database } from "./db.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";

export const testConfig: Config = {
  NODE_ENV: "test",
  PORT: 8080,
  APP_URL: "http://localhost:8080",
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  ENTRA_CLIENT_SECRET: "test-only-not-a-real-secret",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
  DATABASE_URL: "test",
};

export class TestAuth implements AuthProvider {
  async loginUrl(attempt: LoginAttempt) {
    attempt.verifier = "test-verifier";
    return `https://login.example.test/authorize?state=${attempt.state}`;
  }
  async redeem(code: string) {
    if (code === "fail") throw new Error("Provider failed");
    return {
      id: `tenant:${code}`,
      name: code === "alice" ? "Alice Example" : "Bob Example",
      email: `${code}@example.test`,
    };
  }
  logoutUrl() { return "https://login.example.test/logout"; }
}

export async function makeTestApp() {
  const memory = newDb();
  memory.public.registerFunction({
    name: "length", args: [DataType.text], returns: DataType.integer,
    implementation: (value: string) => [...value].length,
  });
  const pool = process.env.TEST_DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    : new (memory.adapters.createPg().Pool)();
  const db = new Database(pool);
  await db.migrate();
  if (process.env.TEST_DATABASE_URL) await pool.query("TRUNCATE todos, users, sessions CASCADE");
  const store = new session.MemoryStore();
  return { app: createApp(testConfig, db, new TestAuth(), store), db, store };
}
