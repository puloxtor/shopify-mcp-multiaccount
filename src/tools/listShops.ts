import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { storeManager } from "../lib/storeManager.js";
import { handleToolError } from "../lib/toolUtils.js";

const ListShopsInputSchema = z.object({});
type ListShopsInput = z.infer<typeof ListShopsInputSchema>;

const listShops = {
  name: "list-shops",
  description:
    "List all configured Shopify stores and show which one is currently active. Use this before switch-shop to see valid store names.",
  schema: ListShopsInputSchema,

  initialize(_client: GraphQLClient) {
    // No-op: this tool reads store state from storeManager directly rather
    // than talking to a single store's GraphQL client.
  },

  execute: async (_input: ListShopsInput) => {
    try {
      const shops = storeManager.list();
      return {
        shops,
        currentStore: shops.find((shop) => shop.current)?.name ?? null,
      };
    } catch (error) {
      handleToolError("list shops", error);
    }
  },
};

export { listShops };
