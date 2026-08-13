/**
 * Runtime registry of connected Shopify stores, the "current store" pointer
 * used by the switch-shop tool, and a routing client that lets every
 * existing tool keep calling a single injected GraphQLClient without
 * knowing multiple stores exist.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { GraphQLClient } from "graphql-request";

import type { ShopifyAuth } from "./shopifyAuth.js";

export interface StoreRuntime {
  name: string;
  domain: string;
  client: GraphQLClient;
  auth: ShopifyAuth | null;
}

export interface StoreSummary {
  name: string;
  domain: string;
  current: boolean;
}

export class StoreManager {
  private stores = new Map<string, StoreRuntime>();
  private currentStoreName: string | null = null;
  private routingClient: GraphQLClient | null = null;

  /**
   * Per-call override for which store `getCurrent()` resolves to.
   *
   * `currentStoreName` is process-wide, which is required for switch-shop to
   * have any effect at all under the HTTP transport: each tool call arrives
   * as its own stateless request (see httpServer.ts), so nothing but a
   * server-side pointer can carry "switched to store X" from one request to
   * the next. But that same process-wide pointer is shared by every
   * concurrent caller — one session's switch-shop can retarget another
   * session's in-flight call. `withStoreOverride` lets a single tool
   * invocation (one that was given an explicit `store` argument, see
   * toolUtils.ts) pin its own store for its own duration without touching
   * the shared pointer other concurrent calls are relying on.
   */
  private readonly override = new AsyncLocalStorage<string>();

  register(store: StoreRuntime): void {
    if (this.stores.has(store.name)) {
      throw new Error(`Store "${store.name}" is already registered.`);
    }
    this.stores.set(store.name, store);
  }

  /**
   * Scopes granted to a store's token, if known.
   *
   * `null` for a static access token (Shopify's OAuth exchange never ran, so
   * there is no scope metadata to read) or before a client-credentials
   * store's first token exchange. An empty array means the app really was
   * granted nothing.
   */
  grantedScopes(name: string): string[] | null {
    return this.stores.get(name)?.auth?.getGrantedScopes() ?? null;
  }

  list(): StoreSummary[] {
    return Array.from(this.stores.values()).map((store) => ({
      name: store.name,
      domain: store.domain,
      current: store.name === this.currentStoreName,
    }));
  }

  getCurrent(): StoreRuntime {
    const name = this.override.getStore() ?? this.currentStoreName;
    if (!name) {
      throw new Error("No Shopify store is currently selected.");
    }
    const store = this.stores.get(name);
    if (!store) {
      const available = Array.from(this.stores.keys()).join(", ") || "(none registered)";
      throw new Error(`Unknown store "${name}". Available stores: ${available}`);
    }
    return store;
  }

  getCurrentName(): string | null {
    return this.override.getStore() ?? this.currentStoreName;
  }

  setCurrent(name: string): StoreRuntime {
    const store = this.stores.get(name);
    if (!store) {
      const available = Array.from(this.stores.keys()).join(", ") || "(none registered)";
      throw new Error(`Unknown store "${name}". Available stores: ${available}`);
    }
    this.currentStoreName = name;
    return store;
  }

  /** Run `fn` with `getCurrent()`/`getCurrentName()` pinned to `name` for its duration. */
  withStoreOverride<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.stores.has(name)) {
      const available = Array.from(this.stores.keys()).join(", ") || "(none registered)";
      return Promise.reject(new Error(`Unknown store "${name}". Available stores: ${available}`));
    }
    return this.override.run(name, fn);
  }

  /**
   * Returns a single GraphQLClient-shaped object that forwards every
   * .request() call to whichever store is currently selected. Every one of
   * the existing tools only ever calls .request(...) on the client it was
   * given at initialize() time, so handing every tool this routing object
   * (instead of a real, fixed GraphQLClient) is enough to make all of them
   * multi-store-aware with no changes to their code.
   *
   * The real GraphQLClient class has private fields, so TypeScript can
   * never structurally accept a plain object in its place — the cast below
   * is a deliberate, narrowly-scoped escape hatch. It's safe because
   * .request() is the only member any tool ever calls on shopifyClient.
   */
  getRoutingClient(): GraphQLClient {
    if (!this.routingClient) {
      const manager = this;
      const proxy = {
        request(...args: unknown[]) {
          // Call .request() as a method on the real client (not a detached
          // function reference) — graphql-request's GraphQLClient.request
          // reads `this.url`/`this.requestConfig` internally, so calling it
          // unbound throws "Cannot read properties of undefined".
          const client = manager.getCurrent().client;
          const requestFn = client.request as (...a: unknown[]) => unknown;
          return requestFn.apply(client, args);
        },
      };
      this.routingClient = proxy as unknown as GraphQLClient;
    }
    return this.routingClient;
  }
}

export const storeManager = new StoreManager();
