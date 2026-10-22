import pg from "pg";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EntraAuth } from "./auth.js";
import { createApp } from "./app.js";
import { errorFields, log, requestContext } from "./logging.js";

async function main() {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
  pool.on("error", (error) => {
    requestContext.exit(() => log("error", "database", "db.connection.failed", errorFields(error)));
  });
  const db = new Database(pool);
  await db.migrate();
  const server = createApp(config, db, new EntraAuth(config)).listen(config.PORT, "0.0.0.0", () => {
    log("info", "runtime", "server.started", { port: config.PORT, disposableDatabase: true });
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("info", "runtime", "server.stopping");
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(() => {
      void pool.end().then(() => process.exit(0)).catch((error: unknown) => {
        log("error", "runtime", "server.shutdown.failed", errorFields(error));
        process.exit(1);
      });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.on("error", (error) => {
    log("error", "runtime", "server.failed", errorFields(error));
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  console.error("Startup failed.", error instanceof Error ? error.message : "Unknown startup error");
  process.exit(1);
});
