#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import minimist from "minimist";
import { z } from "zod";

import { ShopifyApiError } from "./lib/shopifyClient.js";
import { StoreNotFoundError, StoreRegistry } from "./lib/storeRegistry.js";
import { ConfigError, loadConfig } from "./lib/stores.js";
import type { ToolContext } from "./lib/toolUtils.js";
import { annotationsFor, DESTRUCTIVE_TOOLS, tools } from "./tools/registry.js";

// stdout is the MCP transport — every diagnostic must go to stderr.
const log = (message: string) => console.error(message);

dotenv.config();
const argv = minimist(process.argv.slice(2));

// ── Configuration ──────────────────────────────────────────────────────

let registry: StoreRegistry;
try {
  const config = loadConfig(argv, process.env);
  registry = new StoreRegistry(
    config.stores,
    config.apiVersion,
    config.defaultStore,
  );
  log(
    `shopify-mcp: ${config.stores.length} store(s) from ${config.source} — ` +
      `${config.stores.map((s) => s.alias).join(", ")}` +
      (config.defaultStore ? ` (active: ${config.defaultStore})` : " (no default)"),
  );
} catch (error) {
  if (error instanceof ConfigError) {
    log(`shopify-mcp: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const multiStore = registry.size > 1;

// ── MCP server ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "shopify",
  version: "2.0.0",
  description:
    "Manage one or many Shopify stores through the Admin GraphQL API. " +
    "Use list-stores and switch-store to control which store tools act on.",
});

/**
 * `McpServer.registerTool` infers its argument types from the literal shape it
 * is given. That inference is fine for a handful of hand-written tools, but
 * across 40+ heterogeneous shapes — each spread with an extra `store` field —
 * it exceeds TypeScript's instantiation depth limit (TS2589).
 *
 * Registration here is uniform and dynamic, so the inferred types would be
 * erased to `ZodRawShape` anyway. Binding once through an explicit signature
 * keeps the build fast and green; the SDK still validates every call against
 * the same Zod shape at runtime.
 */
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

interface ToolRegistration {
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: Record<string, unknown>;
}

const registerTool = server.registerTool.bind(server) as unknown as (
  name: string,
  config: ToolRegistration,
  handler: ToolHandler,
) => unknown;

/**
 * Build the per-call context.
 *
 * `client` and `store` are getters so that resolving a store only happens when
 * a tool actually needs one. Server-scoped tools (list-stores) therefore keep
 * working even when no store is active or every store is misconfigured.
 */
function buildContext(requestedStore?: string): ToolContext {
  let resolved: { alias: string } | null = null;
  const resolve = () => {
    resolved ??= { alias: registry.resolveAlias(requestedStore) };
    return resolved.alias;
  };

  return {
    registry,
    get client() {
      return registry.getClient(resolve());
    },
    get store() {
      return registry.summary(resolve());
    },
  };
}

const storeArgDescription = `Which store to act on: alias, domain, or label (configured: ${registry
  .aliases()
  .join(", ")}). Omit to use the active store.`;

for (const tool of tools) {
  const isServerScoped = tool.scope === "server";
  const requiresExplicitStore = multiStore && DESTRUCTIVE_TOOLS.has(tool.name);

  // Store-scoped tools gain a `store` argument so a single call can be aimed
  // at any store without changing the session's active store. With only one
  // store configured the argument has nothing to choose between, so it is
  // omitted entirely rather than shipped as noise on all 44 tools.
  const inputSchema: z.ZodRawShape = isServerScoped || !multiStore
    ? tool.schema.shape
    : {
        ...tool.schema.shape,
        store: requiresExplicitStore
          ? z
              .string()
              .describe(
                `${storeArgDescription} Required for this tool because it changes data irreversibly.`,
              )
          : z.string().optional().describe(storeArgDescription),
      };

  const annotations = tool.annotations ?? annotationsFor(tool.name);

  registerTool(
    tool.name,
    {
      description: describeTool(tool.name, tool.description, isServerScoped),
      inputSchema,
      annotations: {
        title: tool.name,
        readOnlyHint: annotations.readOnlyHint ?? false,
        destructiveHint: annotations.destructiveHint ?? false,
        idempotentHint: annotations.idempotentHint ?? false,
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>) => {
      const { store: requestedStore, ...toolArgs } = args ?? {};
      const ctx = buildContext(
        typeof requestedStore === "string" ? requestedStore : undefined,
      );

      try {
        const result = await tool.execute(toolArgs, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                isServerScoped ? result : withStoreContext(result, ctx),
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: explainFailure(error, tool.name) },
          ],
        };
      }
    },
  );
}

/**
 * Stamp every store-scoped result with the store it came from.
 *
 * Without this the model has no way to notice it read from or wrote to the
 * wrong store — the single most consequential failure mode in a multi-account
 * setup.
 */
function withStoreContext(result: unknown, ctx: ToolContext): unknown {
  const store = { alias: ctx.store.alias, domain: ctx.store.domain };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { store, ...(result as Record<string, unknown>) };
  }
  return { store, result };
}

function describeTool(
  name: string,
  description: string,
  isServerScoped: boolean,
): string {
  if (isServerScoped || !multiStore) return description;
  return (
    `${description} ` +
    `Runs against the active store unless you pass \`store\`` +
    (DESTRUCTIVE_TOOLS.has(name)
      ? " — which is required here, since this call cannot be undone."
      : ".")
  );
}

/** Turn any thrown value into one actionable line for the model. */
function explainFailure(error: unknown, toolName: string): string {
  if (error instanceof StoreNotFoundError || error instanceof ShopifyApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message.startsWith("Failed to ")
      ? error.message
      : `Failed to run ${toolName}: ${error.message}`;
  }
  return `Failed to run ${toolName}: ${String(error)}`;
}

// ── Start ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

server.connect(transport).catch((error: unknown) => {
  log(
    `shopify-mcp: failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
