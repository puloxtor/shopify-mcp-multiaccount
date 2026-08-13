#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import type { GraphQLClient } from "graphql-request";
import minimist from "minimist";

import { startHttpServer } from "./lib/httpServer.js";
import { ResilientGraphQLClient } from "./lib/resilientClient.js";
import { ShopifyAuth } from "./lib/shopifyAuth.js";
import { storeManager } from "./lib/storeManager.js";
import type { StoreEntry } from "./lib/storesConfig.js";
import { parseStoresConfig } from "./lib/storesConfig.js";
import { registerTools } from "./lib/toolUtils.js";
import { tools } from "./tools/registry.js";

// Parse command line arguments
const argv = minimist(process.argv.slice(2));

// Load environment variables from .env file (if it exists)
dotenv.config();

const API_VERSION = argv.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-01";

// Resolve which store(s) to connect to. SHOPIFY_STORES (a JSON array) takes
// precedence for multi-store setups; otherwise fall back to the legacy
// single-store env vars/flags, wrapped as one implicit "default" store, so
// existing single-store setups keep working completely unchanged.
const usingMultiStore = !!process.env.SHOPIFY_STORES;
let storeEntries: StoreEntry[];

if (usingMultiStore) {
  try {
    storeEntries = parseStoresConfig(process.env.SHOPIFY_STORES!);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const legacyVarsPresent =
    argv.domain ||
    process.env.MYSHOPIFY_DOMAIN ||
    argv.accessToken ||
    process.env.SHOPIFY_ACCESS_TOKEN ||
    argv.clientId ||
    process.env.SHOPIFY_CLIENT_ID ||
    argv.clientSecret ||
    process.env.SHOPIFY_CLIENT_SECRET;
  if (legacyVarsPresent) {
    console.error(
      "Warning: SHOPIFY_STORES is set; ignoring legacy single-store env vars/flags " +
        "(MYSHOPIFY_DOMAIN, SHOPIFY_ACCESS_TOKEN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, " +
        "--domain, --accessToken, --clientId, --clientSecret)."
    );
  }
} else {
  // Define environment variables - from command line or .env file
  const SHOPIFY_ACCESS_TOKEN =
    argv.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;
  const SHOPIFY_CLIENT_ID = argv.clientId || process.env.SHOPIFY_CLIENT_ID;
  const SHOPIFY_CLIENT_SECRET =
    argv.clientSecret || process.env.SHOPIFY_CLIENT_SECRET;
  const MYSHOPIFY_DOMAIN = argv.domain || process.env.MYSHOPIFY_DOMAIN;

  const useClientCredentials = !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);

  // Validate required environment variables
  if (!SHOPIFY_ACCESS_TOKEN && !useClientCredentials) {
    console.error("Error: Authentication credentials are required.");
    console.error("");
    console.error("Option 1 — Static access token (legacy apps):");
    console.error("  --accessToken=shpat_xxxxx");
    console.error("");
    console.error("Option 2 — Client credentials (Dev Dashboard apps, Jan 2026+):");
    console.error("  --clientId=your_client_id --clientSecret=your_client_secret");
    process.exit(1);
  }

  if (!MYSHOPIFY_DOMAIN) {
    console.error("Error: MYSHOPIFY_DOMAIN is required.");
    console.error("Please provide it via command line argument or .env file.");
    console.error("  Command line: --domain=your-store.myshopify.com");
    process.exit(1);
  }

  storeEntries = [
    useClientCredentials
      ? {
          name: "default",
          domain: MYSHOPIFY_DOMAIN,
          clientId: SHOPIFY_CLIENT_ID!,
          clientSecret: SHOPIFY_CLIENT_SECRET!,
        }
      : {
          name: "default",
          domain: MYSHOPIFY_DOMAIN,
          accessToken: SHOPIFY_ACCESS_TOKEN!,
        },
  ];
}

interface StoreRuntimeResult {
  name: string;
  domain: string;
  client: GraphQLClient;
  auth: ShopifyAuth | null;
}

async function buildStoreRuntime(entry: StoreEntry): Promise<StoreRuntimeResult> {
  let accessToken: string;
  let auth: ShopifyAuth | null = null;

  if (entry.clientId && entry.clientSecret) {
    auth = new ShopifyAuth({
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      shopDomain: entry.domain,
    });
    accessToken = await auth.initialize();
  } else {
    accessToken = entry.accessToken!;
  }

  // ResilientGraphQLClient matches the two members ShopifyAuth and every tool
  // actually use on a graphql-request GraphQLClient (.request, .setHeader),
  // so this swap needs no other file changed. It adds a request timeout,
  // retry with backoff on 429/5xx/network errors and Shopify's THROTTLED
  // error, and errors that name the store and explain ACCESS_DENIED instead
  // of embedding the whole GraphQL document.
  const client = new ResilientGraphQLClient({
    storeName: entry.name,
    domain: entry.domain,
    apiVersion: API_VERSION,
    accessToken,
    scopes: auth ? { granted: () => auth!.getGrantedScopes() } : undefined,
  }) as unknown as GraphQLClient;

  // Let the auth manager hot-swap this store's token header on refresh
  if (auth) {
    auth.setGraphQLClient(client);
  }

  return { name: entry.name, domain: entry.domain, client, auth };
}

// A store that fails to connect (bad credentials, app not installed on that
// shop, etc.) must not take down every other already-working store — build
// each one independently and skip the ones that fail.
const buildResults = await Promise.allSettled(storeEntries.map((entry) => buildStoreRuntime(entry)));
const storeRuntimes: StoreRuntimeResult[] = [];
buildResults.forEach((result, i) => {
  if (result.status === "fulfilled") {
    storeRuntimes.push(result.value);
  } else {
    const entry = storeEntries[i];
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.error(`Warning: failed to connect to store "${entry.name}" (${entry.domain}): ${reason}`);
    console.error(`  Skipping "${entry.name}" for now. Fix its credentials and redeploy to add it back.`);
  }
});

if (storeRuntimes.length === 0) {
  console.error("Error: failed to connect to any configured store. Exiting.");
  process.exit(1);
}

for (const runtime of storeRuntimes) {
  storeManager.register(runtime);
}

const connectedNames = new Set(storeRuntimes.map((runtime) => runtime.name));
const initialStoreName =
  storeEntries.find((entry) => entry.default && connectedNames.has(entry.name))?.name ?? storeRuntimes[0].name;
storeManager.setCurrent(initialStoreName);

if (!usingMultiStore) {
  // Store in process.env for backwards compatibility
  const [{ domain, auth }] = storeRuntimes;
  process.env.MYSHOPIFY_DOMAIN = domain;
  process.env.SHOPIFY_ACCESS_TOKEN = auth ? auth.getAccessToken() : storeEntries[0].accessToken;
}

// Initialize all tools with a routing client that forwards every request to
// whichever store is currently selected (see StoreManager.getRoutingClient)
const routingClient = storeManager.getRoutingClient();
for (const tool of tools) {
  tool.initialize(routingClient);
}

const serverInfo = {
  name: "shopify",
  version: "1.0.0",
  description:
    "MCP Server for Shopify API, enabling interaction with store data through GraphQL API",
};

// Transport defaults to stdio (a local subprocess a client spawns directly,
// e.g. via npx) unless MCP_TRANSPORT=http is set, for running this as an
// always-on remote server (e.g. on Railway).
const MCP_TRANSPORT = (argv.transport || process.env.MCP_TRANSPORT || "stdio").toLowerCase();

if (MCP_TRANSPORT === "http") {
  const MCP_AUTH_TOKEN = argv.authToken || process.env.MCP_AUTH_TOKEN;
  if (!MCP_AUTH_TOKEN || MCP_AUTH_TOKEN.length < 16) {
    console.error("Error: MCP_AUTH_TOKEN is required for HTTP transport and must be at least 16 characters.");
    console.error("Anyone who knows this server's URL but not this token cannot use it.");
    console.error("Generate one, e.g.: openssl rand -hex 32");
    console.error("Then set it via --authToken=... or the MCP_AUTH_TOKEN environment variable.");
    process.exit(1);
  }

  const PORT = Number(argv.port || process.env.PORT || 3000);

  // The OAuth flow (needed for claude.ai / Claude Desktop connectors) needs
  // to know this server's own externally-reachable HTTPS URL. Railway sets
  // RAILWAY_PUBLIC_DOMAIN automatically once a domain is generated; other
  // hosts (or a custom domain) can set MCP_PUBLIC_URL explicitly.
  const explicitPublicUrl = argv.publicUrl || process.env.MCP_PUBLIC_URL;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const rawPublicUrl = explicitPublicUrl || (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${PORT}`);

  let publicUrl: URL;
  try {
    publicUrl = new URL(rawPublicUrl);
  } catch {
    console.error(`Error: could not parse public URL "${rawPublicUrl}". Set MCP_PUBLIC_URL to this server's externally-reachable https URL.`);
    process.exit(1);
  }

  startHttpServer({
    port: PORT,
    authToken: MCP_AUTH_TOKEN,
    publicUrl,
    tools,
    serverInfo,
    multiStore: storeRuntimes.length > 1,
  });
} else if (MCP_TRANSPORT === "stdio") {
  const server = new McpServer(serverInfo);
  registerTools(server, tools, { multiStore: storeRuntimes.length > 1 });

  const transport = new StdioServerTransport();
  server
    .connect(transport)
    .then(() => {})
    .catch((error: unknown) => {
      console.error("Failed to start Shopify MCP Server:", error);
    });
} else {
  console.error(`Error: Unknown MCP_TRANSPORT "${MCP_TRANSPORT}". Expected "stdio" or "http".`);
  process.exit(1);
}
