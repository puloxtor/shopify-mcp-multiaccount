import type { z } from "zod";
import type { ShopifyClient } from "./shopifyClient.js";
import type { StoreRegistry, StoreSummary } from "./storeRegistry.js";

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

/**
 * Everything a tool call needs, resolved per invocation rather than once per
 * process. `client` and `store` are lazy getters: reading either resolves the
 * target store, so server-scoped tools (list-stores) never trigger resolution
 * and never fail when no store is active.
 */
export interface ToolContext {
  readonly registry: StoreRegistry;
  readonly client: ShopifyClient;
  readonly store: StoreSummary;
}

/** Context for tools that operate on the registry itself, not on a store. */
export type ServerContext = Pick<ToolContext, "registry">;

export interface ToolAnnotations {
  /** Tool only reads; safe to call speculatively. */
  readOnlyHint?: boolean;
  /** Tool may destroy or irreversibly alter data. */
  destructiveHint?: boolean;
  /** Repeating the call with the same args has no additional effect. */
  idempotentHint?: boolean;
}

export interface ShopifyTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations?: ToolAnnotations;
  /**
   * "store" (default) — runs against one Shopify store, accepts a `store` arg.
   * "server" — operates on the store registry itself.
   */
  scope?: "store" | "server";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
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
 * Extract nodes from a Shopify connection's edges array.
 */
export function edgesToNodes<T>(connection: ShopifyConnection<T>): T[] {
  return connection.edges.map((edge) => edge.node);
}

/**
 * Accept either a numeric Shopify ID or a full GID and return the numeric part.
 *
 * List tools return GIDs (`gid://shopify/Customer/123`), so requiring a bare
 * numeric ID on the matching detail tools broke the obvious list-then-fetch
 * flow. Both forms are now accepted everywhere.
 */
export function toNumericId(value: string, resource: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const gidMatch = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(trimmed);
  if (gidMatch) return gidMatch[2]!;

  throw new Error(
    `Invalid ${resource} ID "${value}". Expected a numeric ID (e.g. "6276879810626") ` +
      `or a GID (e.g. "gid://shopify/${resource}/6276879810626").`,
  );
}

/**
 * Extract shopMoney from a Shopify MoneyBag (e.g. totalPriceSet.shopMoney).
 */
export function shopMoney(
  moneyBag: { shopMoney: ShopifyMoney } | null | undefined,
): ShopifyMoney | null {
  return moneyBag?.shopMoney ?? null;
}
