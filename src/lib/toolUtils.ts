import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { storeManager } from "./storeManager.js";

// ── Shared Shopify types ──────────────────────────────────────────────

export interface ShopifyUserError {
  field: string;
  message: string;
  code?: string;
}

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyEdge<T> {
  node: T;
}

export interface ShopifyConnection<T> {
  edges: ShopifyEdge<T>[];
  pageInfo?: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

// ── Tool registry interface ───────────────────────────────────────────

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ShopifyTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations?: ToolAnnotations;
  /** Store-management tools (list-shops, switch-shop) skip the injected `store` argument. */
  scope?: "store" | "server";
  initialize(client: GraphQLClient): void;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Tools that can destroy or irreversibly alter data. */
export const DESTRUCTIVE_TOOLS = new Set([
  "delete-product",
  "delete-product-variants",
  "delete-customer",
  "delete-metafields",
  "order-cancel",
  "refund-create",
  "customer-merge",
  "complete-draft-order",
  "create-fulfillment",
  "order-mark-as-paid",
  "inventory-set-quantities",
  "graphql-mutation",
]);

function annotationsFor(tool: ShopifyTool): ToolAnnotations {
  if (tool.annotations) return tool.annotations;
  if (DESTRUCTIVE_TOOLS.has(tool.name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  }
  if (tool.name.startsWith("get-") || tool.name === "graphql-query" || tool.name === "list-shops") {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  }
  return { readOnlyHint: false, destructiveHint: false };
}

// ── Utility functions ─────────────────────────────────────────────────

/**
 * Throw a formatted error if Shopify userErrors array is non-empty.
 */
export function checkUserErrors(
  errors: ShopifyUserError[],
  operation: string,
): void {
  if (errors.length > 0) {
    throw new Error(
      `Failed to ${operation}: ${errors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ")}`,
    );
  }
}

/**
 * Catch handler that doesn't re-wrap errors already thrown by checkUserErrors.
 * Fixes the double-wrapping bug where "Failed to X: Failed to X: actual message"
 * was produced by every mutation tool.
 */
export function handleToolError(operation: string, error: unknown): never {
  // If the error already has our "Failed to" prefix, re-throw as-is
  if (error instanceof Error && error.message.startsWith("Failed to ")) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Failed to ${operation}: ${message}`);
}

/**
 * `McpServer.registerTool`'s generics are inferred from the literal shape
 * passed in. Doing that across 40+ heterogeneous tool shapes here — each
 * optionally spread with an extra `store` field — exceeds TypeScript's
 * instantiation depth limit (TS2589). Registration here is uniform and
 * dynamic, so the inferred types would be erased to `ZodRawShape` anyway;
 * binding once through an explicit signature keeps the build green without
 * losing runtime validation (the SDK still validates every call against the
 * same Zod shape).
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

/**
 * Register every tool's schema/handler on an MCP server instance. Shared
 * between the stdio transport (registered once at startup) and the HTTP
 * transport (registered fresh per stateless request), so every fix here
 * applies to both.
 *
 * Previously called `server.tool(name, schema.shape, cb)`, which matches the
 * SDK's `(name, description, cb)` overload — the description every tool
 * defines was silently discarded, leaving the model with 44 bare tool names
 * and argument schemas but no explanation of what any of them do. Switched to
 * `registerTool` with an explicit `description` and read-only/destructive
 * annotations.
 *
 * Also adds an optional `store` argument to every store-scoped tool when more
 * than one store is configured, so a single call can target a specific store
 * without mutating the shared "current store" pointer that concurrent HTTP
 * callers may be relying on (see storeManager.ts).
 */
export function registerTools(
  server: McpServer,
  tools: ShopifyTool[],
  options: { multiStore?: boolean } = {},
): void {
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: ToolRegistration,
    handler: ToolHandler,
  ) => unknown;

  const multiStore = options.multiStore ?? false;
  const storeArgDescription = multiStore
    ? "Which store to run this call against, by name (as returned by list-shops). Overrides the active store for this call only, without switching it."
    : undefined;

  for (const tool of tools) {
    const isServerScoped = tool.scope === "server";
    const offerStoreArg = multiStore && !isServerScoped;

    const inputSchema: z.ZodRawShape = offerStoreArg
      ? { ...tool.schema.shape, store: z.string().min(1).optional().describe(storeArgDescription!) }
      : tool.schema.shape;

    const annotations = annotationsFor(tool);

    registerTool(
      tool.name,
      {
        description: offerStoreArg
          ? `${tool.description} Runs against the active store unless you pass \`store\`.`
          : tool.description,
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
        const run = () => tool.execute(toolArgs);

        try {
          const result =
            typeof requestedStore === "string" && requestedStore.length > 0
              ? await storeManager.withStoreOverride(requestedStore, run)
              : await run();
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message.startsWith("Failed to ")
                ? error.message
                : `Failed to run ${tool.name}: ${error.message}`
              : `Failed to run ${tool.name}: ${String(error)}`;
          return { isError: true, content: [{ type: "text", text: message }] };
        }
      },
    );
  }
}

/**
 * Extract nodes from a Shopify connection's edges array.
 */
export function edgesToNodes<T>(connection: ShopifyConnection<T>): T[] {
  return connection.edges.map((edge) => edge.node);
}

/**
 * Extract shopMoney from a Shopify MoneyBag (e.g. totalPriceSet.shopMoney).
 */
export function shopMoney(
  moneyBag: { shopMoney: ShopifyMoney } | null | undefined,
): ShopifyMoney | null {
  return moneyBag?.shopMoney ?? null;
}
