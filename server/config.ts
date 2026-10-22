import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  APP_URL: z.url(),
  ENTRA_TENANT_ID: z.uuid().transform((value) => value.toLowerCase()),
  ENTRA_CLIENT_ID: z.uuid().transform((value) => value.toLowerCase()),
  ENTRA_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  DATABASE_URL: z.string().min(1),
});

export function loadConfig(env: NodeJS.ProcessEnv) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}. See .env.example.`);
  }
  const config = result.data;
  const url = new URL(config.APP_URL);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_URL must be an origin without credentials, path, query or fragment.");
  }
  if (config.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS in production.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("APP_URL must use HTTPS, except on localhost.");
  }
  return { ...config, APP_URL: url.origin };
}

export type Config = ReturnType<typeof loadConfig>;
