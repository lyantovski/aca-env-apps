import { createApp } from "../server/app.js";
import { makeTestApp, testConfig, TestAuth } from "../server/test-support.js";
import { LoggedSessionStore } from "../server/session-store.js";

// Test-only identity provider. This file is not compiled into the runtime image.
const context = await makeTestApp();
const store = process.env.TEST_DATABASE_URL ? new LoggedSessionStore(context.db.pool) : context.store;
const app = createApp({ ...testConfig, APP_URL: "http://localhost:4173" }, context.db, new TestAuth(), store);
const server = app.listen(4173, () => console.log("Browser test fixture listening on 4173."));
function close() {
  server.close(() => {
    void (async () => {
      if (store instanceof LoggedSessionStore) await store.close();
      await context.db.pool.end();
      process.exit(0);
    })();
  });
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
