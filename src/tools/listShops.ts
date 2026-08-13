import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { storeManager } from "../lib/storeManager.js";
import { handleToolError } from "../lib/toolUtils.js";

const ListShopsInputSchema = z.object({});
type ListShopsInput = z.infer<typeof ListShopsInputSchema>;

const listShops = {
  name: "list-shops",
  description:
    "List all configured Shopify stores and show which one is currently active, plus the Admin API scopes granted to each. " +
    "Use this before switch-shop to see valid store names, and to catch an app installed with no access scopes before it produces a wall of ACCESS_DENIED errors.",
  schema: ListShopsInputSchema,
  scope: "server" as const,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },

  initialize(_client: GraphQLClient) {
    // No-op: this tool reads store state from storeManager directly rather
    // than talking to a single store's GraphQL client.
  },

  execute: async (_input: ListShopsInput) => {
    try {
      const shops = storeManager.list();
      return {
        shops: shops.map((shop) => {
          const scopes = storeManager.grantedScopes(shop.name);
          return {
            ...shop,
            accessScopes: scopes,
            warning:
              scopes !== null && scopes.length === 0
                ? "This store's token has NO Admin API access scopes. Every tool except get-shop-info will fail with ACCESS_DENIED. Configure the app's scopes and reinstall it on this store, then restart the server."
                : undefined,
          };
        }),
        currentStore: shops.find((shop) => shop.current)?.name ?? null,
        note: "In HTTP mode the active store is shared server-wide across concurrent callers. Pass `store` on an individual call to target a store without switching the shared active one.",
      };
    } catch (error) {
      handleToolError("list shops", error);
    }
  },
};

export { listShops };
