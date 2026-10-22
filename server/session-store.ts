import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import { errorFields, log, traceDatabaseCallback } from "./logging.js";

const PgStore = connectPgSimple(session);

export class LoggedSessionStore extends PgStore {
  constructor(pool: Pool) {
    super({
      pool, tableName: "sessions", createTableIfMissing: false,
      errorLog: (...args: unknown[]) => log("error", "database", "db.session_store.failed",
        errorFields(args.find((value) => value instanceof Error))),
    });
  }

  override get(sid: string, callback: Parameters<InstanceType<typeof PgStore>["get"]>[1]) {
    traceDatabaseCallback<[session?: SessionData | null]>("sessions.read",
      (done) => super.get(sid, done), callback);
  }

  override set(sid: string, value: SessionData, callback?: (error?: unknown) => void) {
    traceDatabaseCallback("sessions.write",
      (done) => super.set(sid, value, done), (error) => callback?.(error));
  }

  override destroy(sid: string, callback?: (error?: unknown) => void) {
    traceDatabaseCallback("sessions.delete",
      (done) => super.destroy(sid, done), (error) => callback?.(error));
  }

  override touch(sid: string, value: SessionData, callback?: (error?: unknown) => void) {
    traceDatabaseCallback("sessions.touch",
      (done) => super.touch(sid, value, (error?: unknown) => done(error)), (error) => callback?.(error));
  }
}
