import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { testConfig } from "./test-support.js";

describe("configuration", () => {
  const env = { ...testConfig, PORT: "8080" };
  it("accepts localhost development and normalizes an origin", () => {
    expect(loadConfig({ ...env, APP_URL: "http://localhost:8080/" }).APP_URL).toBe("http://localhost:8080");
  });
  it("accepts HTTPS production", () => {
    expect(loadConfig({ ...env, NODE_ENV: "production", APP_URL: "https://tasks.example.test" }).PORT).toBe(8080);
  });
  it("normalizes identity IDs so tenant claim checks are case independent", () => {
    const id = "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF";
    expect(loadConfig({ ...env, ENTRA_TENANT_ID: id }).ENTRA_TENANT_ID).toBe(id.toLowerCase());
  });
  it("requires tenant, client and strong session configuration without exposing secrets", () => {
    expect(() => loadConfig({ ...env, ENTRA_TENANT_ID: "", SESSION_SECRET: "short" })).toThrow("ENTRA_TENANT_ID, SESSION_SECRET");
    expect(() => loadConfig({ ...env, ENTRA_CLIENT_SECRET: "" })).toThrow("ENTRA_CLIENT_SECRET");
  });
  it("rejects insecure production, non-local HTTP and non-origin URLs", () => {
    for (const APP_URL of ["http://example.test", "https://example.test/path", "https://user:pass@example.test", "https://example.test/?a=b"]) {
      expect(() => loadConfig({ ...env, APP_URL })).toThrow();
    }
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow("HTTPS");
  });
});
