import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { storeManager } from "../lib/storeManager.js";
import { handleToolError } from "../lib/toolUtils.js";

const SwitchShopInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'The store name to switch to, as returned by list-shops (the "name" field, not the domain).',
    ),
});
type SwitchShopInput = z.infer<typeof SwitchShopInputSchema>;

const switchShop = {
  name: "switch-shop",
  description:
    "Switch the active Shopify store. All subsequent tool calls (get-products, create-product, get-orders, etc.) act on this store until switch-shop is called again. Wait for this tool's result before issuing dependent tool calls. " +
    "This changes a server-wide pointer, so under concurrent use prefer passing `store` on individual calls instead.",
  schema: SwitchShopInputSchema,
  scope: "server" as const,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },

  initialize(_client: GraphQLClient) {
    // No-op: switching stores only mutates storeManager's current-store
    // pointer, it never talks to Shopify itself.
  },

  execute: async ({ name }: SwitchShopInput) => {
    try {
      const store = storeManager.setCurrent(name);
      return { switchedTo: store.name, domain: store.domain };
    } catch (error) {
      handleToolError(`switch to store "${name}"`, error);
    }
  },
};

export { switchShop };
