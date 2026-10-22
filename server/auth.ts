import { ConfidentialClientApplication, CryptoProvider } from "@azure/msal-node";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Identity } from "./db.js";

export interface LoginAttempt {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
}

export interface AuthProvider {
  loginUrl(attempt: LoginAttempt): Promise<string>;
  redeem(code: string, attempt: LoginAttempt): Promise<Identity>;
  logoutUrl(): string;
}

export class EntraAuth implements AuthProvider {
  private readonly authority: string;
  private readonly redirectUri: string;

  constructor(private readonly config: Config) {
    this.authority = `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}`;
    this.redirectUri = `${config.APP_URL}/auth/callback`;
  }

  private client() {
    return new ConfidentialClientApplication({
      auth: {
        clientId: this.config.ENTRA_CLIENT_ID,
        clientSecret: this.config.ENTRA_CLIENT_SECRET,
        authority: this.authority,
      },
    });
  }

  async loginUrl(attempt: LoginAttempt) {
    const challenge = await new CryptoProvider().generatePkceCodes();
    attempt.verifier = challenge.verifier;
    return this.client().getAuthCodeUrl({
      scopes: ["openid", "profile", "email"],
      redirectUri: this.redirectUri,
      responseMode: "query",
      state: attempt.state,
      nonce: attempt.nonce,
      codeChallenge: challenge.challenge,
      codeChallengeMethod: "S256",
    });
  }

  async redeem(code: string, attempt: LoginAttempt): Promise<Identity> {
    const token = await this.client().acquireTokenByCode({
      code,
      scopes: ["openid", "profile", "email"],
      redirectUri: this.redirectUri,
      codeVerifier: attempt.verifier,
    });
    const claims = z.object({
      nonce: z.string(),
      tid: z.uuid(),
      oid: z.uuid(),
      preferred_username: z.string().optional(),
    }).parse(token.idTokenClaims);
    if (claims.nonce !== attempt.nonce || claims.tid !== this.config.ENTRA_TENANT_ID || typeof claims.oid !== "string") {
      throw new Error("Identity claims did not match the login request.");
    }
    return {
      id: `${claims.tid}:${claims.oid}`,
      name: token.account?.name || "Microsoft user",
      email: typeof claims.preferred_username === "string" ? claims.preferred_username : "",
    };
  }

  logoutUrl() {
    const url = new URL(`${this.authority}/oauth2/v2.0/logout`);
    url.searchParams.set("post_logout_redirect_uri", this.config.APP_URL);
    return url.toString();
  }
}
