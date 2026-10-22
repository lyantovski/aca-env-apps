import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, { type ErrorRequestHandler, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Config } from "./config.js";
import type { AuthProvider, LoginAttempt } from "./auth.js";
import type { Database } from "./db.js";
import { errorFields, log, requestLogging } from "./logging.js";
import { LoggedSessionStore } from "./session-store.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrfToken?: string;
    loginAttempt?: LoginAttempt;
  }
}

function randomToken() {
  return randomBytes(32).toString("hex");
}

function equalToken(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const title = z.string().trim().min(1).max(200);
const createTodo = z.object({ title }).strict();
const patchTodo = z.object({ title: title.optional(), completed: z.boolean().optional() }).strict()
  .refine((patch) => patch.title !== undefined || patch.completed !== undefined);

export function createApp(config: Config, db: Database, auth: AuthProvider, store?: session.Store) {
  const app = express();
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(requestLogging);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "form-action": ["'self'"],
        "upgrade-insecure-requests": config.NODE_ENV === "production" ? [] : null,
      },
    },
  }));
  app.get("/health/live", (_req, res) => res.json({ status: "alive" }));
  app.get("/health/ready", async (_req, res, next) => {
    try {
      await db.ready();
      res.json({ status: "ready" });
    } catch (error) {
      log("error", "backend", "health.readiness.failed", errorFields(error));
      res.status(503).json({ error: "Database is unavailable." });
    }
  });
  app.use(express.json({ limit: "8kb" }));
  app.use(session({
    name: "pocket.sid",
    secret: config.SESSION_SECRET,
    store: store ?? new LoggedSessionStore(db.pool),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    },
  }));
  app.use(["/api", "/auth"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many requests. Please wait a minute." } }));
  app.get("/api/session", async (req, res) => {
    req.session.csrfToken ??= randomToken();
    const user = req.session.userId ? await db.user(req.session.userId) : null;
    if (!user) delete req.session.userId;
    res.json({ user, csrfToken: req.session.csrfToken });
  });
  app.get("/auth/login", rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Please wait a minute." } }), async (req, res) => {
    const attempt: LoginAttempt = { state: randomToken(), nonce: randomToken(), verifier: "", createdAt: Date.now() };
    const url = await auth.loginUrl(attempt);
    log("info", "backend", "auth.signin.started");
    req.session.loginAttempt = attempt;
    await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    res.redirect(url);
  });
  app.get("/auth/callback", async (req, res) => {
    const attempt = req.session.loginAttempt;
    delete req.session.loginAttempt;
    const state = req.query.state;
    if (!attempt || typeof state !== "string" || !equalToken(state, attempt.state) ||
        Date.now() - attempt.createdAt > 10 * 60_000) {
      log("warn", "backend", "auth.signin.rejected", { reason: "invalid_state" });
      res.redirect("/?authError=invalid_state");
      return;
    }
    await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    if (req.query.error || typeof req.query.code !== "string") {
      log("warn", "backend", "auth.signin.rejected", { reason: "cancelled_or_denied" });
      res.redirect("/?authError=signin_cancelled");
      return;
    }
    try {
      const identity = await auth.redeem(req.query.code, attempt);
      const user = await db.upsertUser(identity);
      await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      req.session.userId = user.id;
      req.session.csrfToken = randomToken();
      await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      log("info", "backend", "auth.signin.completed");
      res.redirect("/");
    } catch (error) {
      log("error", "backend", "auth.signin.failed", errorFields(error));
      res.redirect("/?authError=signin_failed");
    }
  });

  const csrf = (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
    const token = req.get("X-CSRF-Token");
    if (req.get("Origin") !== config.APP_URL || !token || !req.session.csrfToken || !equalToken(token, req.session.csrfToken)) {
      res.status(403).json({ error: "Request verification failed. Refresh the page and try again." });
      return;
    }
    next();
  };
  app.post("/auth/logout", csrf, async (req, res) => {
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    res.clearCookie("pocket.sid", { path: "/", httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production" });
    log("info", "backend", "auth.signout.completed");
    res.json({ redirectUrl: auth.logoutUrl() });
  });
  app.use("/api", csrf, async (req, res, next) => {
    if (!req.session.userId || !await db.user(req.session.userId)) {
      res.status(401).json({ error: "Please sign in to continue." });
      return;
    }
    res.locals.userId = req.session.userId;
    next();
  });
  app.patch("/api/profile", async (req, res) => {
    const data = z.object({ theme: z.enum(["light", "dark"]) }).strict().parse(req.body);
    res.json(await db.setTheme(res.locals.userId, data.theme));
  });
  app.get("/api/todos", async (_req, res) => res.json(await db.todos(res.locals.userId)));
  app.post("/api/todos", async (req, res) => {
    const data = createTodo.parse(req.body);
    res.status(201).json(await db.addTodo(res.locals.userId, data.title));
  });
  app.patch("/api/todos/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const todo = await db.updateTodo(res.locals.userId, id, patchTodo.parse(req.body));
    if (!todo) { res.status(404).json({ error: "Task not found." }); return; }
    res.json(todo);
  });
  app.delete("/api/todos/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    if (!await db.deleteTodo(res.locals.userId, id)) { res.status(404).json({ error: "Task not found." }); return; }
    res.sendStatus(204);
  });
  app.use(["/api", "/auth"], (_req, res) => res.status(404).json({ error: "Endpoint not found." }));
  const clientDir = path.resolve("dist/client");
  app.use(express.static(clientDir, {
    setHeaders: (res, filePath) => {
      res.setHeader("Cache-Control", filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600");
    },
  }));
  app.get("/", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
  app.use((_req, res) => res.status(404).json({ error: "Page not found." }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      log("warn", "backend", "http.request.rejected", { reason: "invalid_input" });
      res.status(400).json({ error: "Invalid input. Task titles must contain 1–200 characters; settings and task IDs must be valid." });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      log("warn", "backend", "http.request.rejected", { reason: "invalid_json" });
      res.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    if (error && typeof error === "object" && "status" in error && error.status === 413) {
      log("warn", "backend", "http.request.rejected", { reason: "body_too_large" });
      res.status(413).json({ error: "Request body is too large." });
      return;
    }
    log("error", "backend", "http.request.failed", errorFields(error));
    res.status(500).json({ error: "Something went wrong on the server. Please try again." });
  };
  app.use(errors);
  return app;
}
