/**
 * Streamable HTTP transport for running this server as a remote, always-on
 * MCP endpoint (e.g. on Railway) instead of a local stdio subprocess.
 *
 * Runs stateless (a fresh McpServer + transport per request, per the SDK's
 * own simpleStatelessStreamableHttp example) since all real state already
 * lives in the process-wide StoreManager singleton, not on any one
 * connection. Every request to /mcp must carry a bearer token matching
 * MCP_AUTH_TOKEN — without it, anyone who finds the URL could otherwise
 * fully manage the connected Shopify store(s) (create/delete products,
 * issue refunds, cancel orders, etc.).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";

import { registerTools } from "./toolUtils.js";
import type { ShopifyTool } from "./toolUtils.js";

export interface StartHttpServerOptions {
  port: number;
  authToken: string;
  tools: ShopifyTool[];
  serverInfo: { name: string; version: string; description: string };
}

function requireBearerToken(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const [scheme, token] = (req.header("authorization") ?? "").split(" ");
    if (scheme !== "Bearer" || token !== expectedToken) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
        id: null,
      });
      return;
    }
    next();
  };
}

export function startHttpServer({ port, authToken, tools, serverInfo }: StartHttpServerOptions): void {
  const app = express();
  app.use(express.json());
  app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));

  // Unauthenticated: Railway (and other platforms) health-check this route
  // without any headers.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const auth = requireBearerToken(authToken);

  app.post("/mcp", auth, async (req, res) => {
    const server = new McpServer(serverInfo);
    registerTools(server, tools);
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
  app.get("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(port, () => {
    console.error(`Shopify MCP Server listening on port ${port} (Streamable HTTP, POST /mcp)`);
  });
}
