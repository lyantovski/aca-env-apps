import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { Theme, Todo, User } from "../shared/types.js";
import { traceDatabase } from "./logging.js";

export const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark'))
);
CREATE TABLE IF NOT EXISTS todos (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS todos_user_id_idx ON todos(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
`;

export interface Identity {
  id: string;
  name: string;
  email: string;
}

const columns = `id, title, completed, created_at AS "createdAt"`;

export class Database {
  constructor(readonly pool: Pool) {}

  async migrate() {
    await this.query("schema.migrate", schemaSql);
  }

  query<Row extends QueryResultRow = QueryResultRow>(operation: string, sql: string, values?: unknown[]) {
    return traceDatabase(operation, () => this.pool.query<Row>(sql, values));
  }

  async ready() {
    await this.query("health.ready", "SELECT 1");
  }

  async upsertUser(identity: Identity): Promise<User> {
    const result = await this.query<User>("users.upsert",
      `INSERT INTO users (id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email
       RETURNING id, name, email, theme`,
      [identity.id, identity.name, identity.email],
    );
    return result.rows[0];
  }

  async user(id: string): Promise<User | null> {
    const result = await this.query<User>("users.read", "SELECT id, name, email, theme FROM users WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async setTheme(id: string, theme: Theme): Promise<User> {
    const result = await this.query<User>("users.set_theme",
      "UPDATE users SET theme = $2 WHERE id = $1 RETURNING id, name, email, theme", [id, theme],
    );
    if (!result.rows[0]) throw new Error("Authenticated user no longer exists.");
    return result.rows[0];
  }

  async todos(userId: string): Promise<Todo[]> {
    const result = await this.query<Todo>("todos.list",
      `SELECT ${columns} FROM todos WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [userId],
    );
    return result.rows;
  }

  async addTodo(userId: string, title: string): Promise<Todo> {
    const result = await this.query<Todo>("todos.create",
      `INSERT INTO todos (id, user_id, title) VALUES ($1, $2, $3) RETURNING ${columns}`,
      [randomUUID(), userId, title],
    );
    return result.rows[0];
  }

  async updateTodo(userId: string, id: string, patch: { title?: string; completed?: boolean }): Promise<Todo | null> {
    const result = await this.query<Todo>("todos.update",
      `UPDATE todos SET title = COALESCE($3, title), completed = COALESCE($4, completed)
       WHERE id = $1 AND user_id = $2 RETURNING ${columns}`,
      [id, userId, patch.title ?? null, patch.completed ?? null],
    );
    return result.rows[0] ?? null;
  }

  async deleteTodo(userId: string, id: string): Promise<boolean> {
    const result = await this.query("todos.delete", "DELETE FROM todos WHERE id = $1 AND user_id = $2", [id, userId]);
    return result.rowCount === 1;
  }
}
