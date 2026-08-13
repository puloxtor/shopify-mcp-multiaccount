import { z } from "zod";
import { gql } from "../lib/gql.js";
import type { ServerContext } from "../lib/toolUtils.js";

const SwitchStoreInputSchema = z.object({
  store: z
    .string()
    .describe(
      'Store to make active. Accepts the alias ("acme"), the full domain ("acme.myshopify.com"), or the store label.',
    ),
});
type SwitchStoreInput = z.infer<typeof SwitchStoreInputSchema>;

// `appInstallation.accessScopes` is what actually gates every other tool, and
// it needs no scope of its own to read — so verifying it here turns the most
// common misconfiguration (an app installed with no Admin API scopes, where
// shop info succeeds and every resource query returns ACCESS_DENIED) into an
// answer at switch time rather than a wall of denials later.
const VERIFY_QUERY = gql`
  #graphql

  query SwitchStoreVerify {
    shop {
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

interface VerifyResponse {
  shop: {
    name: string;
    myshopifyDomain: string;
    currencyCode: string;
    ianaTimezone: string;
  };
  currentAppInstallation?: {
    accessScopes?: Array<{ handle: string }> | null;
  } | null;
}

const switchStore = {
  name: "switch-store",
  description:
    "Make a different Shopify store the active one for subsequent tool calls. " +
    "Verifies credentials against the Shopify API before switching, and returns the live shop name so you can confirm you landed on the right store. " +
    "If verification fails the active store is left unchanged. " +
    "You do not need this to act on another store just once — every tool takes an optional `store` argument for a single call.",
  schema: SwitchStoreInputSchema,
  scope: "server" as const,
  annotations: { readOnlyHint: false, idempotentHint: true },

  execute: async (input: SwitchStoreInput, ctx: ServerContext) => {
    const { registry } = ctx;

    // Resolve without committing, so a failed verification cannot leave the
    // session pointing at a store we know is unreachable.
    const target = registry.summary(registry.resolveAlias(input.store));
    const previous = registry.activeAlias ?? null;

    if (previous === target.alias) {
      return {
        activeStore: target.alias,
        domain: target.domain,
        changed: false,
        message: `Already on "${target.alias}" (${target.domain}).`,
      };
    }

    const data = await registry
      .getClient(target.alias)
      .request<VerifyResponse>(VERIFY_QUERY);

    registry.setActive(target.alias);

    const scopes = (data.currentAppInstallation?.accessScopes ?? []).map(
      (s) => s.handle,
    );
    const message = `Switched to "${target.alias}" — ${data.shop.name} (${data.shop.myshopifyDomain}). Verified against the Shopify API.`;

    return {
      activeStore: target.alias,
      previousStore: previous,
      changed: true,
      domain: target.domain,
      shopName: data.shop.name,
      currencyCode: data.shop.currencyCode,
      timezone: data.shop.ianaTimezone,
      accessScopes: scopes,
      message: scopes.length
        ? message
        : `${message} WARNING: this app has NO Admin API access scopes on this store, so every tool except get-shop-info will fail with ACCESS_DENIED. Configure the app's scopes and reinstall it on this store, then restart the server.`,
    };
  },
};

export { switchStore };
