/**
 * Runtime registry of configured stores.
 *
 * Owns two things the previous single-store design could not express:
 *   - one `ShopifyClient` per store, created lazily on first use, so a broken
 *     or unreachable store never prevents the server from starting or blocks
 *     work on the other stores;
 *   - the "active store", so a conversation can switch context once and have
 *     subsequent calls follow, while any single call can still override it.
 */

import {
  ClientCredentialsProvider,
  StaticTokenProvider,
  type TokenProvider,
} from "./shopifyAuth.js";
import { ShopifyClient } from "./shopifyClient.js";
import type { StoreConfig } from "./stores.js";

export interface StoreSummary {
  alias: string;
  label?: string;
  domain: string;
  auth: TokenProvider["kind"];
  apiVersion: string;
  active: boolean;
  /** Whether a client has been created and used at least once this session. */
  connected: boolean;
}

interface Connection {
  client: ShopifyClient;
  tokens: TokenProvider;
}

export class StoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreNotFoundError";
  }
}

export class StoreRegistry {
  private readonly configs = new Map<string, StoreConfig>();
  private readonly connections = new Map<string, Connection>();
  private active: string | undefined;

  constructor(
    stores: StoreConfig[],
    private readonly defaultApiVersion: string,
    defaultStore?: string,
  ) {
    for (const store of stores) {
      this.configs.set(store.alias, store);
    }
    this.active = defaultStore;
  }

  get size(): number {
    return this.configs.size;
  }

  get activeAlias(): string | undefined {
    return this.active;
  }

  aliases(): string[] {
    return [...this.configs.keys()];
  }

  list(): StoreSummary[] {
    return [...this.configs.values()].map((config) => ({
      alias: config.alias,
      label: config.label,
      domain: config.domain,
      auth: config.accessToken ? "access_token" : "client_credentials",
      apiVersion: config.apiVersion ?? this.defaultApiVersion,
      active: config.alias === this.active,
      connected: this.connections.has(config.alias),
    }));
  }

  summary(alias: string): StoreSummary {
    const found = this.list().find((s) => s.alias === alias);
    if (!found) throw new StoreNotFoundError(this.unknownStoreMessage(alias));
    return found;
  }

  /**
   * Turn an optional per-call `store` argument into a concrete alias.
   *
   * Accepts an alias, a full domain, or a store label so the model can pass
   * back whatever identifier it last saw in a response.
   */
  resolveAlias(requested?: string): string {
    if (requested?.trim()) {
      const match = this.match(requested.trim());
      if (!match) throw new StoreNotFoundError(this.unknownStoreMessage(requested));
      return match;
    }

    if (this.active) return this.active;

    if (this.configs.size === 1) {
      return this.aliases()[0]!;
    }

    throw new StoreNotFoundError(
      `No store selected. Pass store="<alias>" on this call, or use switch-store first. ` +
        `Configured stores: ${this.aliases().join(", ")}.`,
    );
  }

  setActive(alias: string): StoreSummary {
    const resolved = this.match(alias);
    if (!resolved) throw new StoreNotFoundError(this.unknownStoreMessage(alias));
    this.active = resolved;
    return this.summary(resolved);
  }

  /**
   * Scopes the store's token was granted, if known.
   *
   * `null` for a static access token (Shopify returns no scope metadata with
   * one) or before the first client-credentials exchange.
   */
  grantedScopes(alias: string): string[] | null {
    return this.connections.get(alias)?.tokens.grantedScopes ?? null;
  }

  getClient(alias: string): ShopifyClient {
    const existing = this.connections.get(alias);
    if (existing) return existing.client;

    const config = this.configs.get(alias);
    if (!config) throw new StoreNotFoundError(this.unknownStoreMessage(alias));

    const tokens: TokenProvider = config.accessToken
      ? new StaticTokenProvider(config.accessToken)
      : new ClientCredentialsProvider({
          clientId: config.clientId!,
          clientSecret: config.clientSecret!,
          shopDomain: config.domain,
          storeAlias: config.alias,
        });

    const client = new ShopifyClient({
      storeAlias: config.alias,
      domain: config.domain,
      apiVersion: config.apiVersion ?? this.defaultApiVersion,
      tokens,
    });

    this.connections.set(alias, { client, tokens });
    return client;
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Match on alias, then exact domain, then label, then unique prefix. */
  private match(input: string): string | undefined {
    const needle = input.toLowerCase().trim();
    if (this.configs.has(needle)) return needle;

    const domain = needle.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    for (const config of this.configs.values()) {
      if (config.domain === domain) return config.alias;
      if (config.label?.toLowerCase() === needle) return config.alias;
    }

    const prefixed = [...this.configs.values()].filter(
      (c) =>
        c.alias.startsWith(needle) ||
        c.domain.startsWith(needle) ||
        c.label?.toLowerCase().startsWith(needle),
    );
    return prefixed.length === 1 ? prefixed[0]!.alias : undefined;
  }

  private unknownStoreMessage(requested: string): string {
    return (
      `Unknown store "${requested}". Configured stores: ${this.aliases().join(", ")}. ` +
      `Use list-stores to see them with their domains.`
    );
  }
}
