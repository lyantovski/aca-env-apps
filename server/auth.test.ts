import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntraAuth, type LoginAttempt } from "./auth.js";
import { testConfig } from "./test-support.js";

const msal = vi.hoisted(() => ({
  authorize: vi.fn(),
  redeem: vi.fn(),
  pkce: vi.fn(),
}));

vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    getAuthCodeUrl = msal.authorize;
    acquireTokenByCode = msal.redeem;
  },
  CryptoProvider: class { generatePkceCodes = msal.pkce; },
}));

describe("Entra authentication adapter", () => {
  const attempt: LoginAttempt = { state: "state", nonce: "nonce", verifier: "", createdAt: Date.now() };
  const oid = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    vi.resetAllMocks();
    msal.pkce.mockResolvedValue({ challenge: "challenge", verifier: "verifier" });
    msal.authorize.mockResolvedValue("https://login.microsoftonline.com/authorize");
    msal.redeem.mockResolvedValue({
      idTokenClaims: { nonce: "nonce", tid: testConfig.ENTRA_TENANT_ID, oid, preferred_username: "alice@example.test" },
      account: { name: "Alice Example" },
    });
  });

  it("requests OIDC sign-in with state, nonce and S256 PKCE", async () => {
    const current = { ...attempt };
    await new EntraAuth(testConfig).loginUrl(current);
    expect(current.verifier).toBe("verifier");
    expect(msal.authorize).toHaveBeenCalledWith({
      scopes: ["openid", "profile", "email"],
      redirectUri: "http://localhost:8080/auth/callback",
      responseMode: "query",
      state: "state", nonce: "nonce", codeChallenge: "challenge", codeChallengeMethod: "S256",
    });
  });

  it("uses PKCE when redeeming the code and derives identity from tenant and object ID", async () => {
    const identity = await new EntraAuth(testConfig).redeem("authorization-code", { ...attempt, verifier: "verifier" });
    expect(msal.redeem).toHaveBeenCalledWith({
      code: "authorization-code", scopes: ["openid", "profile", "email"],
      redirectUri: "http://localhost:8080/auth/callback", codeVerifier: "verifier",
    });
    expect(identity).toEqual({ id: `${testConfig.ENTRA_TENANT_ID}:${oid}`, name: "Alice Example", email: "alice@example.test" });
  });

  it.each([
    { nonce: "wrong", tid: testConfig.ENTRA_TENANT_ID, oid },
    { nonce: "nonce", tid: "44444444-4444-4444-8444-444444444444", oid },
    { nonce: "nonce", tid: testConfig.ENTRA_TENANT_ID },
  ])("rejects mismatched or missing claims: %j", async (claims) => {
    msal.redeem.mockResolvedValue({ idTokenClaims: claims });
    await expect(new EntraAuth(testConfig).redeem("code", attempt)).rejects.toThrow();
  });

  it("returns to the configured origin after Microsoft logout", () => {
    const url = new URL(new EntraAuth(testConfig).logoutUrl());
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe(`/${testConfig.ENTRA_TENANT_ID}/oauth2/v2.0/logout`);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(testConfig.APP_URL);
  });
});
