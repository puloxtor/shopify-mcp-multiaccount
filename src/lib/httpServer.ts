/**
 * Streamable HTTP transport for running this server as a remote, always-on
 * MCP endpoint (e.g. on Railway) instead of a local stdio subprocess.
 *
 * Runs stateless (a fresh McpServer + transport per request, per the SDK's
 * own simpleStatelessStreamableHttp example) since all real state already
 * lives in the process-wide StoreManager singleton, not on any one
 * connection.
 *
 * Two ways to authenticate against /mcp:
 *  - A static bearer token (MCP_AUTH_TOKEN) in the Authorization header --
 *    what Claude Code's `claude mcp add --header` supports.
 *  - The MCP OAuth flow -- required by claude.ai / Claude Desktop's
 *    "Connectors" UI, which only supports remote MCP servers with a real
 *    sign-in step, not a manually-entered header. See oauthProvider.ts.
 * Without one of these, anyone who finds the URL could fully manage the
 * connected Shopify store(s) (create/delete products, issue refunds, etc.).
 */

import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";

import { ShopifyMcpAuthProvider, renderLoginPage } from "./oauthProvider.js";
import { registerTools } from "./toolUtils.js";
import type { ShopifyTool } from "./toolUtils.js";

export interface StartHttpServerOptions {
  port: number;
  authToken: string;
  publicUrl: URL;
  tools: ShopifyTool[];
  serverInfo: { name: string; version: string; description: string };
  multiStore?: boolean;
}

export function startHttpServer({
  port,
  authToken,
  publicUrl,
  tools,
  serverInfo,
  multiStore = false,
}: StartHttpServerOptions): void {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));

  // Unauthenticated: Railway (and other platforms) health-check this route
  // without any headers.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const provider = new ShopifyMcpAuthProvider(authToken);

  // Metadata discovery, dynamic client registration, GET /authorize (renders
  // the login form via provider.authorize), and POST /token.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "Shopify MCP Multi-Account",
    }),
  );

  // The actual login-form submission. Kept as our own route (rather than
  // inside provider.authorize) so we get direct access to the posted form
  // body -- the SDK's OAuthServerProvider.authorize() only receives the
  // already-validated OAuth params, not arbitrary extra fields like a
  // password.
  app.post(
    "/authorize/confirm",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
      const { client_id, redirect_uri, code_challenge, state, scope, resource, token } = req.body ?? {};
      const client = typeof client_id === "string" ? provider.clientsStore.getClient(client_id) : undefined;

      if (!client || typeof redirect_uri !== "string" || !client.redirect_uris.includes(redirect_uri)) {
        res.status(400).send("Invalid or expired authorization request. Please try connecting again.");
        return;
      }

      const params = {
        state: typeof state === "string" && state.length > 0 ? state : undefined,
        scopes: typeof scope === "string" && scope.length > 0 ? scope.split(" ") : [],
        codeChallenge: typeof code_challenge === "string" ? code_challenge : "",
        redirectUri: redirect_uri,
        resource: typeof resource === "string" && resource.length > 0 ? new URL(resource) : undefined,
      };

      if (typeof token !== "string" || !provider.verifyLoginSecret(token)) {
        res.status(401).setHeader("Content-Type", "text/html");
        res.send(renderLoginPage({ client, params, error: "Incorrect access token. Please try again." }));
        return;
      }

      await provider.completeAuthorization(client, params, res);
    },
  );

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(publicUrl);
  const requireAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post("/mcp", requireAuth, async (req, res) => {
    const server = new McpServer(serverInfo);
    registerTools(server, tools, { multiStore });
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no session to resume (GET) or end (DELETE).
  app.get("/mcp", requireAuth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", requireAuth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(port, () => {
    console.error(`Shopify MCP Server listening on port ${port} (Streamable HTTP, POST /mcp)`);
    console.error(`OAuth issuer: ${publicUrl.href}`);
  });
}
