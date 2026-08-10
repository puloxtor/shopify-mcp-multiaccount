/**
 * Minimal OAuth 2.1 authorization server so this MCP server can be added as
 * a "Connector" in claude.ai / Claude Desktop, which only support remote
 * MCP servers that implement the MCP OAuth flow (a static bearer token in a
 * header field, like Claude Code's --header flag supports, isn't an option
 * in that UI).
 *
 * This is intentionally personal-tool scale, matching the rest of this
 * server's multi-store design: in-memory client/code/token storage (lost on
 * restart -- anyone connected will need to reauthorize), a single shared
 * login secret (MCP_AUTH_TOKEN, the same value usable as a static bearer
 * token) instead of per-user accounts, and no token revocation endpoint.
 * The one thing this must NOT skip is the login step itself: unlike the
 * MCP SDK's own DemoInMemoryAuthProvider example (which auto-approves every
 * authorization request with no credential check at all -- fine for a demo,
 * unacceptable for a server with real write access to a Shopify store),
 * `authorize()` here renders a real login form and issues a code only after
 * /authorize/confirm verifies the submitted secret.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; exchangeRefreshToken lets clients renew silently
const STATIC_TOKEN_TTL_SECONDS = 10 * 365 * 24 * 60 * 60; // effectively "doesn't expire"

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // seconds since epoch
  resource?: URL;
}

interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  resource?: URL;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid a length-based timing signal.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function renderLoginPage(options: {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  error?: string;
}): string {
  const { client, params, error } = options;
  const clientName = client.client_name ? escapeHtml(client.client_name) : "An MCP client";
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sign in - Shopify MCP Multi-Account</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f10; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a1c; border: 1px solid #2a2a2d; border-radius: 12px; padding: 32px; width: 320px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: #9a9a9e; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #3a3a3d; background: #0f0f10; color: #e6e6e6; font-size: 14px; }
  button { width: 100%; margin-top: 16px; padding: 10px 12px; border-radius: 8px; border: none; background: #d97757; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #c96a4b; }
  .error { color: #f5a3a3; font-size: 13px; margin: 0 0 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Shopify MCP Multi-Account</h1>
    <p>${clientName} wants to connect. Enter the server's access token to continue.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="POST" action="/authorize/confirm">
      ${hidden("client_id", client.client_id)}
      ${hidden("redirect_uri", params.redirectUri)}
      ${hidden("code_challenge", params.codeChallenge)}
      ${hidden("state", params.state ?? "")}
      ${hidden("scope", (params.scopes ?? []).join(" "))}
      ${hidden("resource", params.resource?.toString() ?? "")}
      <label for="token">Access token</label>
      <input type="password" id="token" name="token" autofocus autocomplete="off">
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class ShopifyMcpAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();
  private codes = new Map<string, PendingAuthorization>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(private readonly loginSecret: string) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader("Content-Type", "text/html");
    res.send(renderLoginPage({ client, params }));
  }

  /** Called by the POST /authorize/confirm route (see httpServer.ts) after verifying the submitted token. */
  async completeAuthorization(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const code = randomUUID();
    this.codes.set(code, { client, params });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) {
      target.searchParams.set("state", params.state);
    }
    res.redirect(target.toString());
  }

  verifyLoginSecret(submitted: string): boolean {
    return timingSafeEqualStrings(submitted, this.loginSecret);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.client.client_id !== client.client_id) {
      throw new Error("Invalid authorization code");
    }
    return pending.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const pending = this.codes.get(authorizationCode);
    if (!pending) {
      throw new Error("Invalid authorization code");
    }
    if (pending.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    this.codes.delete(authorizationCode);

    const scopes = pending.params.scopes ?? [];
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      resource: pending.params.resource,
    });
    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes,
      resource: pending.params.resource,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new Error("Invalid refresh token");
    }

    const grantedScopes = scopes ?? record.scopes;
    const accessToken = randomUUID();
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: grantedScopes,
      expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      resource: record.resource,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: grantedScopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (timingSafeEqualStrings(token, this.loginSecret)) {
      return {
        token,
        clientId: "static-token",
        scopes: ["mcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SECONDS,
      };
    }

    const record = this.accessTokens.get(token);
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error("Invalid or expired token");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource,
    };
  }
}

export { renderLoginPage };
