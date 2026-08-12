/**
 * Access-token providers for the Shopify Admin API.
 *
 * Two flavours:
 *   - `StaticTokenProvider`      — legacy custom apps with a `shpat_…` token.
 *   - `ClientCredentialsProvider` — Dev Dashboard apps (January 2026+), which
 *     only hand out a client_id / client_secret pair that must be exchanged
 *     for a short-lived token (`expires_in` ≈ 86 400 s).
 *
 * Token freshness is enforced on the *request path* rather than by a
 * background timer. A `setTimeout`-based refresh silently misses its window
 * whenever the host machine sleeps — the common case for a desktop MCP
 * client — leaving every subsequent call to fail with 401 until restart.
 * Checking expiry before each request (plus an explicit `invalidate()` hook
 * for 401 responses) is correct across suspend/resume.
 */

export interface TokenProvider {
  /** Return a valid access token, refreshing it if necessary. */
  getToken(): Promise<string>;
  /** Mark the current token as unusable so the next getToken() refetches. */
  invalidate(): void;
  /** Human-readable auth mode, for diagnostics. */
  readonly kind: "access_token" | "client_credentials";
}

export class StaticTokenProvider implements TokenProvider {
  readonly kind = "access_token" as const;

  constructor(private readonly token: string) {}

  async getToken(): Promise<string> {
    return this.token;
  }

  invalidate(): void {
    // A static token cannot be refreshed; nothing to do. The caller surfaces
    // the 401 to the user, which is the only actionable outcome here.
  }
}

export interface ClientCredentialsConfig {
  clientId: string;
  clientSecret: string;
  shopDomain: string;
  /** Label used in error messages, usually the store alias. */
  storeAlias: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
}

/** Refresh this long before real expiry to absorb clock skew and latency. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export class ClientCredentialsProvider implements TokenProvider {
  readonly kind = "client_credentials" as const;

  private token: string | null = null;
  private expiresAt = 0;
  /** De-duplicates concurrent refreshes so parallel tool calls exchange once. */
  private inFlight: Promise<string> | null = null;

  constructor(private readonly config: ClientCredentialsConfig) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.token;
    }
    if (!this.inFlight) {
      this.inFlight = this.exchange().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async exchange(): Promise<string> {
    const url = `https://${this.config.shopDomain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `[${this.config.storeAlias}] Could not reach ${this.config.shopDomain} to exchange credentials: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `[${this.config.storeAlias}] Token exchange failed: ${describeTokenFailure(
          res.status,
          await safeBody(res),
          this.config.shopDomain,
        )}`,
      );
    }

    let data: TokenResponse;
    try {
      data = (await res.json()) as TokenResponse;
    } catch {
      throw new Error(
        `[${this.config.storeAlias}] Token exchange returned a non-JSON response from ${this.config.shopDomain}. ` +
          `Check that the domain is a real myshopify.com store.`,
      );
    }

    if (!data.access_token) {
      throw new Error(
        `[${this.config.storeAlias}] Token exchange succeeded but returned no access_token.`,
      );
    }

    this.token = data.access_token;
    // Default to 24 h if Shopify ever omits expires_in.
    this.expiresAt = Date.now() + (data.expires_in ?? 86_400) * 1000;
    return this.token;
  }
}

/**
 * Turn a token-exchange failure into one actionable sentence.
 *
 * Shopify answers an unknown shop with a full HTML "Store unavailable" page;
 * echoing that verbatim (as the previous implementation did) buries the cause
 * in kilobytes of markup.
 */
function describeTokenFailure(
  status: number,
  body: string,
  domain: string,
): string {
  if (status === 404) {
    return `HTTP 404 — ${domain} does not resolve to a Shopify store. Check the domain spelling (it should look like your-store.myshopify.com).`;
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status} — the client ID/secret was rejected. Check the credentials and that the app is installed on ${domain}.`;
  }
  if (status === 400) {
    return `HTTP 400 — ${summarise(body)} (usually a malformed client ID/secret, or an app that is not configured for the client_credentials grant).`;
  }
  if (status >= 500) {
    return `HTTP ${status} — Shopify returned a server error. This is usually transient.`;
  }
  return `HTTP ${status} — ${summarise(body)}`;
}

function summarise(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "empty response body";
  if (trimmed.startsWith("<")) return "HTML response (not a JSON API error)";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message =
      parsed.error_description ?? parsed.error ?? parsed.errors ?? null;
    if (message) return String(message);
  } catch {
    // fall through to the truncated raw body
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
