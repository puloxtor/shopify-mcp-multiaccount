/**
 * Drop-in replacement for graphql-request's `GraphQLClient`, matching the
 * only two members any tool in this codebase calls: `.request(query, vars)`
 * and `.setHeader(name, value)` (used by ShopifyAuth to hot-swap the token on
 * refresh). Every existing tool and the store-routing proxy keep working
 * unchanged.
 *
 * What it adds over graphql-request:
 *   - a request timeout (a hung fetch otherwise hangs the tool call forever),
 *   - retry with backoff on 429 / 5xx / network errors,
 *   - retry on Shopify's `THROTTLED` GraphQL error (leaky-bucket rate limit),
 *   - concise errors that name the store and omit the GraphQL document
 *     (graphql-request serialises the whole query into `error.message`),
 *   - a plain-language explanation for `ACCESS_DENIED`, naming the missing
 *     scope and — critically — calling out the case where the app is
 *     installed with zero Admin API scopes at all, which otherwise looks
 *     identical to a broken server (`shop { … }` keeps working; every
 *     resource query fails) and is hard to diagnose from the bare error.
 */

export interface ScopeSource {
  /** Scopes granted to the current token, or null if not yet known. */
  granted(): string[] | null;
}

export interface ResilientClientOptions {
  storeName: string;
  domain: string;
  apiVersion: string;
  accessToken: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Full endpoint override, for tests. */
  endpoint?: string;
  scopes?: ScopeSource;
}

interface GraphQLResponseError {
  message: string;
  extensions?: {
    code?: string;
    requiredAccess?: string;
    [key: string]: unknown;
  };
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: GraphQLResponseError[];
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly storeName: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

const FIELD_SCOPES: Record<string, string> = {
  products: "read_products",
  product: "read_products",
  productVariants: "read_products",
  collections: "read_products",
  collection: "read_products",
  orders: "read_orders",
  order: "read_orders",
  draftOrders: "read_draft_orders",
  draftOrder: "read_draft_orders",
  customers: "read_customers",
  customer: "read_customers",
  locations: "read_locations",
  location: "read_locations",
  inventoryItems: "read_inventory",
  inventoryItem: "read_inventory",
  inventoryLevel: "read_inventory",
  markets: "read_markets",
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 8_000;

type AttemptOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "unauthorized"; status: number }
  | {
      kind: "retryable";
      message: string;
      status?: number;
      code?: string;
      retryAfterMs?: number;
    }
  | { kind: "fatal"; message: string; status?: number; code?: string };

export class ResilientGraphQLClient {
  private endpoint: string;
  private token: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ResilientClientOptions) {
    this.endpoint =
      options.endpoint ??
      `https://${options.domain}/admin/api/${options.apiVersion}/graphql.json`;
    this.token = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Matches graphql-request's `GraphQLClient.setHeader` for the one header ShopifyAuth sets. */
  setHeader(name: string, value: string): void {
    if (name.toLowerCase() === "x-shopify-access-token") {
      this.token = value;
    }
  }

  async request<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const isLastAttempt = attempt >= this.maxAttempts;
      let outcome: AttemptOutcome<T>;

      try {
        outcome = await this.attempt<T>(query, variables);
      } catch (error) {
        if (isLastAttempt) throw this.networkError(error, attempt);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (outcome.kind === "ok") return outcome.data;

      if (outcome.kind === "unauthorized") {
        throw new ShopifyApiError(
          `[${this.options.storeName}] Shopify rejected the credentials (HTTP ${outcome.status}). ` +
            `The access token is invalid, revoked, or the app's token needs to be reissued. Store: ${this.options.domain}`,
          this.options.storeName,
          outcome.status,
        );
      }

      if (outcome.kind === "retryable") {
        if (isLastAttempt) {
          throw new ShopifyApiError(
            `[${this.options.storeName}] ${outcome.message} (gave up after ${attempt} attempts)`,
            this.options.storeName,
            outcome.status,
            outcome.code,
          );
        }
        await sleep(outcome.retryAfterMs ?? backoffMs(attempt));
        continue;
      }

      throw new ShopifyApiError(
        `[${this.options.storeName}] ${outcome.message}`,
        this.options.storeName,
        outcome.status,
        outcome.code,
      );
    }
  }

  private async attempt<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<AttemptOutcome<T>> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": this.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 401 || res.status === 403) {
      return { kind: "unauthorized", status: res.status };
    }
    if (res.status === 429) {
      return {
        kind: "retryable",
        message: "Shopify rate limit reached (HTTP 429)",
        status: 429,
        code: "RATE_LIMITED",
        retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")),
      };
    }
    if (res.status >= 500) {
      return { kind: "retryable", message: `Shopify returned HTTP ${res.status}`, status: res.status };
    }
    if (res.status === 404) {
      return {
        kind: "fatal",
        message: `${this.options.domain} did not respond to the Admin API (HTTP 404). Check the store domain and API version "${this.options.apiVersion}".`,
        status: 404,
      };
    }

    const raw = await res.text();
    let body: GraphQLResponseBody<T>;
    try {
      body = JSON.parse(raw) as GraphQLResponseBody<T>;
    } catch {
      return {
        kind: res.ok ? "fatal" : "retryable",
        message: `Shopify returned a non-JSON response (HTTP ${res.status})`,
        status: res.status,
      };
    }

    if (body.errors?.length) {
      const codes = body.errors
        .map((e) => e.extensions?.code)
        .filter((c): c is string => typeof c === "string");
      const message = body.errors.map((e) => e.message).filter(Boolean).join("; ");

      if (codes.includes("THROTTLED")) {
        return { kind: "retryable", message: "Shopify API rate limit reached (THROTTLED)", code: "THROTTLED" };
      }
      if (codes.includes("ACCESS_DENIED")) {
        return {
          kind: "fatal",
          message: this.explainAccessDenied(body.errors, message),
          status: res.status,
          code: "ACCESS_DENIED",
        };
      }
      return {
        kind: "fatal",
        message: `Shopify API error: ${message || "unknown GraphQL error"}`,
        status: res.status,
        code: codes[0],
      };
    }

    if (body.data === undefined || body.data === null) {
      return { kind: "fatal", message: "Shopify returned an empty response with no errors", status: res.status };
    }

    return { kind: "ok", data: body.data };
  }

  private explainAccessDenied(errors: GraphQLResponseError[], joinedMessage: string): string {
    const fields = errors
      .map((e) => /Access denied for (\w+)/.exec(e.message)?.[1])
      .filter((f): f is string => Boolean(f));
    const stated = errors
      .map((e) => e.extensions?.requiredAccess)
      .find((r): r is string => typeof r === "string" && r.length > 0);
    const needed = [...new Set(fields.map((f) => FIELD_SCOPES[f]).filter((s): s is string => Boolean(s)))];

    const parts = [
      `Access denied${fields.length ? ` for ${[...new Set(fields)].join(", ")}` : ""} on ${this.options.domain}.`,
    ];

    const granted = this.options.scopes?.granted() ?? null;
    if (granted !== null && granted.length === 0) {
      parts.push(
        `This app's token was granted no Admin API access scopes at all, so every resource query will fail while shop info keeps working.`,
        `Configure the scopes on the app and reinstall it on this store, then restart the server so a new token is issued.`,
      );
    } else {
      if (stated) parts.push(`Shopify says: ${stated}`);
      else if (needed.length) parts.push(`Needs the ${needed.join(" and ")} scope${needed.length > 1 ? "s" : ""}.`);
      else parts.push(`The app's token is missing the Admin API scope for this field.`);
      if (granted?.length) parts.push(`Currently granted: ${granted.join(", ")}.`);
      parts.push(`Scope changes only apply to newly issued tokens — update the app's scopes, reinstall it on this store, then restart the server.`);
    }
    if (!fields.length && joinedMessage) parts.push(`(${joinedMessage})`);
    return parts.join(" ");
  }

  private networkError(error: unknown, attempts: number): ShopifyApiError {
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const detail = isTimeout
      ? `no response within ${this.timeoutMs / 1000}s`
      : error instanceof Error
        ? error.message
        : String(error);
    return new ShopifyApiError(
      `[${this.options.storeName}] Could not reach ${this.options.domain}: ${detail} (gave up after ${attempts} attempts)`,
      this.options.storeName,
      undefined,
      isTimeout ? "TIMEOUT" : "NETWORK",
    );
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
