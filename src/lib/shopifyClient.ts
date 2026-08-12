/**
 * Shopify Admin GraphQL client.
 *
 * Replaces `graphql-request` so the transport can own the things a
 * multi-store MCP server actually needs:
 *   - a request timeout (a hung fetch otherwise hangs the tool call forever),
 *   - retry with backoff on 429 / 5xx / network blips,
 *   - retry on Shopify's `THROTTLED` GraphQL error (leaky-bucket rate limit),
 *   - a single transparent token refresh on 401,
 *   - error messages that name the store and omit the GraphQL document.
 *
 * That last point matters more than it looks: `graphql-request` serialises the
 * entire query into `error.message`, so one failed call used to return ~1.5 kB
 * of GraphQL source to the model instead of a one-line cause.
 */

import type { TokenProvider } from "./shopifyAuth.js";

export interface ShopifyClientOptions {
  storeAlias: string;
  domain: string;
  apiVersion: string;
  tokens: TokenProvider;
  timeoutMs?: number;
  maxAttempts?: number;
  /**
   * Full GraphQL endpoint override. Not settable from store configuration —
   * it exists so tests can point the client at a local stand-in server and
   * exercise the retry, throttle and token-refresh paths for real.
   */
  endpoint?: string;
}

interface GraphQLResponseError {
  message: string;
  extensions?: { code?: string; [key: string]: unknown };
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: GraphQLResponseError[];
}

/** An error that already carries a user-facing, store-qualified message. */
export class ShopifyApiError extends Error {
  readonly storeAlias: string;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    details: { storeAlias: string; status?: number; code?: string },
  ) {
    super(message);
    this.name = "ShopifyApiError";
    this.storeAlias = details.storeAlias;
    this.status = details.status;
    this.code = details.code;
  }
}

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

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 8_000;

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ShopifyClientOptions) {
    this.endpoint =
      options.endpoint ??
      `https://${options.domain}/admin/api/${options.apiVersion}/graphql.json`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  get storeAlias(): string {
    return this.options.storeAlias;
  }

  get domain(): string {
    return this.options.domain;
  }

  async request<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let refreshedOn401 = false;

    for (let attempt = 1; ; attempt++) {
      const isLastAttempt = attempt >= this.maxAttempts;
      let outcome: AttemptOutcome<T>;

      try {
        outcome = await this.attempt<T>(query, variables);
      } catch (error) {
        // Network-level failure (DNS, TLS, connection reset, timeout).
        if (isLastAttempt) throw this.networkError(error, attempt);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (outcome.kind === "ok") return outcome.data;

      if (outcome.kind === "unauthorized") {
        // Exchange a fresh token once, then retry. Beyond that the credentials
        // or scopes are genuinely wrong and retrying just hides the cause.
        if (!refreshedOn401 && this.options.tokens.kind === "client_credentials") {
          refreshedOn401 = true;
          this.options.tokens.invalidate();
          continue;
        }
        throw new ShopifyApiError(
          `[${this.storeAlias}] Shopify rejected the credentials (HTTP ${outcome.status}). ` +
            (this.options.tokens.kind === "access_token"
              ? "The access token is invalid, revoked, or missing the required scopes."
              : "Check the client ID/secret and that the app is installed with the required Admin API scopes.") +
            ` Store: ${this.domain}`,
          { storeAlias: this.storeAlias, status: outcome.status },
        );
      }

      if (outcome.kind === "retryable") {
        if (isLastAttempt) {
          throw new ShopifyApiError(
            `[${this.storeAlias}] ${outcome.message} (gave up after ${attempt} attempts)`,
            {
              storeAlias: this.storeAlias,
              status: outcome.status,
              code: outcome.code,
            },
          );
        }
        await sleep(outcome.retryAfterMs ?? backoffMs(attempt));
        continue;
      }

      throw new ShopifyApiError(`[${this.storeAlias}] ${outcome.message}`, {
        storeAlias: this.storeAlias,
        status: outcome.status,
        code: outcome.code,
      });
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  private async attempt<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<AttemptOutcome<T>> {
    const token = await this.options.tokens.getToken();

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
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
      return {
        kind: "retryable",
        message: `Shopify returned HTTP ${res.status}`,
        status: res.status,
      };
    }

    if (res.status === 404) {
      return {
        kind: "fatal",
        message:
          `${this.domain} did not respond to the Admin API (HTTP 404). ` +
          `Check the store domain and that the API version "${this.options.apiVersion}" is still supported.`,
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
      const message = body.errors
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ");

      if (codes.includes("THROTTLED")) {
        return {
          kind: "retryable",
          message: "Shopify API rate limit reached (THROTTLED)",
          code: "THROTTLED",
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
      return {
        kind: "fatal",
        message: "Shopify returned an empty response with no errors",
        status: res.status,
      };
    }

    return { kind: "ok", data: body.data };
  }

  private networkError(error: unknown, attempts: number): ShopifyApiError {
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const detail = isTimeout
      ? `no response within ${this.timeoutMs / 1000}s`
      : error instanceof Error
        ? error.message
        : String(error);
    return new ShopifyApiError(
      `[${this.storeAlias}] Could not reach ${this.domain}: ${detail} (gave up after ${attempts} attempts)`,
      { storeAlias: this.storeAlias, code: isTimeout ? "TIMEOUT" : "NETWORK" },
    );
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
