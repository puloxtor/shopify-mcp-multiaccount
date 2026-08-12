import { z } from "zod";
import type { ServerContext } from "../lib/toolUtils.js";

const ListStoresInputSchema = z.object({});
type ListStoresInput = z.infer<typeof ListStoresInputSchema>;

const listStores = {
  name: "list-stores",
  description:
    "List every Shopify store this server is configured for, showing each store's alias, domain and which one is currently active. " +
    "Call this first when you are unsure which store you are working with, or when the user mentions a store by name. " +
    "Purely local — makes no API calls and does not need credentials to work.",
  schema: ListStoresInputSchema,
  scope: "server" as const,
  annotations: { readOnlyHint: true, idempotentHint: true },

  execute: async (_input: ListStoresInput, ctx: ServerContext) => {
    const stores = ctx.registry.list();
    const active = ctx.registry.activeAlias;

    return {
      activeStore: active ?? null,
      storeCount: stores.length,
      stores: stores.map((store) => ({
        alias: store.alias,
        label: store.label ?? null,
        domain: store.domain,
        active: store.active,
        auth: store.auth,
        apiVersion: store.apiVersion,
        usedThisSession: store.connected,
      })),
      hint: active
        ? `Calls without an explicit "store" argument run against "${active}". Pass store="<alias>" to target a different store for a single call, or use switch-store to change the default.`
        : `No active store yet. Use switch-store, or pass store="<alias>" on each call.`,
    };
  },
};

export { listStores };
