/**
 * Store configuration loading and validation.
 *
 * Config is resolved from the first source that yields anything:
 *   1. `--stores=<path>`  / `SHOPIFY_STORES_FILE` — a JSON file
 *   2. `SHOPIFY_STORES`   — the same JSON, inline
 *   3. the legacy single-store flags (`--domain`, `--accessToken`, …)
 *
 * Every string value supports `${ENV_VAR}` interpolation so a checked-in
 * config file can reference secrets that live in the environment.
 */

import { readFileSync } from "node:fs";

export interface StoreConfig {
  alias: string;
  label?: string;
  domain: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;
}

export interface StoresFile {
  stores: StoreConfig[];
  defaultStore?: string;
  apiVersion?: string;
}

export interface LoadedConfig {
  stores: StoreConfig[];
  defaultStore?: string;
  apiVersion: string;
  /** Where the config came from, for the startup log line. */
  source: string;
}

export const DEFAULT_API_VERSION = "2026-01";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Raised for user-fixable configuration problems. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Argv = Record<string, unknown>;
type Env = Record<string, string | undefined>;

export function loadConfig(argv: Argv, env: Env): LoadedConfig {
  const apiVersion =
    str(argv.apiVersion) ?? env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION;

  const filePath = str(argv.stores) ?? env.SHOPIFY_STORES_FILE;
  const inline = env.SHOPIFY_STORES;

  let parsed: StoresFile | null = null;
  let source: string;

  if (filePath) {
    parsed = parseStoresJson(readConfigFile(filePath), `file ${filePath}`);
    source = `file ${filePath}`;
  } else if (inline?.trim()) {
    parsed = parseStoresJson(inline, "SHOPIFY_STORES");
    source = "SHOPIFY_STORES env var";
  } else {
    const legacy = loadLegacySingleStore(argv, env);
    if (!legacy) {
      throw new ConfigError(
        [
          "No Shopify stores configured.",
          "",
          "Multi-store (recommended) — point at a config file:",
          "  shopify-mcp --stores=/path/to/shopify-stores.json",
          "or set SHOPIFY_STORES to the same JSON inline.",
          "",
          "Config shape:",
          '  { "defaultStore": "acme",',
          '    "stores": [',
          '      { "alias": "acme", "domain": "acme.myshopify.com",',
          '        "clientId": "${ACME_CLIENT_ID}", "clientSecret": "${ACME_CLIENT_SECRET}" },',
          '      { "alias": "widgets", "domain": "widgets.myshopify.com",',
          '        "accessToken": "${WIDGETS_TOKEN}" }',
          "    ] }",
          "",
          "Single store — the legacy flags still work:",
          "  shopify-mcp --domain=your-store.myshopify.com --accessToken=shpat_xxx",
          "  shopify-mcp --domain=your-store.myshopify.com --clientId=… --clientSecret=…",
        ].join("\n"),
      );
    }
    parsed = { stores: [legacy] };
    source = "command-line flags / environment";
  }

  const stores = parsed.stores.map((store, index) =>
    validateStore(store, index, source),
  );

  if (stores.length === 0) {
    throw new ConfigError(`No stores defined in ${source}.`);
  }

  const seen = new Map<string, number>();
  for (const [index, store] of stores.entries()) {
    const previous = seen.get(store.alias);
    if (previous !== undefined) {
      throw new ConfigError(
        `Duplicate store alias "${store.alias}" (entries ${previous + 1} and ${index + 1} in ${source}). Aliases must be unique.`,
      );
    }
    seen.set(store.alias, index);
  }

  const defaultStore = normaliseDefaultStore(parsed, stores, argv, env, source);

  return {
    stores,
    defaultStore,
    apiVersion: parsed.apiVersion ?? apiVersion,
    source,
  };
}

// ── parsing ────────────────────────────────────────────────────────────

function readConfigFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "file not found"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ConfigError(`Could not read store config at ${path}: ${reason}`);
  }
}

function parseStoresJson(raw: string, source: string): StoresFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Interpolate only the fields we actually consume. Doing it over the whole
  // document would also expand `${…}` inside comment keys, which config files
  // legitimately use to *document* the placeholder syntax.
  if (Array.isArray(json)) {
    return { stores: interpolate(json) as StoreConfig[] };
  }
  if (isRecord(json) && Array.isArray(json.stores)) {
    return {
      stores: interpolate(json.stores) as StoreConfig[],
      defaultStore: str(json.defaultStore),
      apiVersion: str(json.apiVersion),
    };
  }
  throw new ConfigError(
    `${source} must be either an array of stores or an object with a "stores" array.`,
  );
}

/** Replace `${VAR}` in every string with the corresponding env var. */
function interpolate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      const resolved = process.env[name as string];
      if (resolved === undefined) {
        throw new ConfigError(
          `Store config references \${${name}} but that environment variable is not set.`,
        );
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v)]),
    );
  }
  return value;
}

function loadLegacySingleStore(argv: Argv, env: Env): StoreConfig | null {
  const domain = str(argv.domain) ?? env.MYSHOPIFY_DOMAIN;
  const accessToken = str(argv.accessToken) ?? env.SHOPIFY_ACCESS_TOKEN;
  const clientId = str(argv.clientId) ?? env.SHOPIFY_CLIENT_ID;
  const clientSecret = str(argv.clientSecret) ?? env.SHOPIFY_CLIENT_SECRET;

  if (!domain && !accessToken && !clientId) return null;

  return {
    alias: str(argv.alias) ?? env.SHOPIFY_STORE_ALIAS ?? aliasFromDomain(domain),
    domain: domain ?? "",
    accessToken,
    clientId,
    clientSecret,
  };
}

// ── validation ─────────────────────────────────────────────────────────

function validateStore(
  store: StoreConfig,
  index: number,
  source: string,
): StoreConfig {
  const where = store?.alias
    ? `store "${store.alias}"`
    : `store #${index + 1} in ${source}`;

  if (!isRecord(store)) {
    throw new ConfigError(`${where}: expected an object.`);
  }

  const domain = normaliseDomain(str(store.domain));
  if (!domain) {
    throw new ConfigError(
      `${where}: "domain" is required (e.g. "your-store.myshopify.com").`,
    );
  }

  const alias = (str(store.alias) ?? aliasFromDomain(domain)).toLowerCase();
  if (!ALIAS_PATTERN.test(alias)) {
    throw new ConfigError(
      `${where}: alias "${alias}" is invalid. Use lowercase letters, digits, "-" and "_", starting with a letter or digit.`,
    );
  }

  const accessToken = str(store.accessToken);
  const clientId = str(store.clientId);
  const clientSecret = str(store.clientSecret);

  if (!accessToken && !(clientId && clientSecret)) {
    throw new ConfigError(
      `store "${alias}": needs either "accessToken", or both "clientId" and "clientSecret".`,
    );
  }
  if (clientId && !clientSecret) {
    throw new ConfigError(`store "${alias}": "clientId" is set but "clientSecret" is missing.`);
  }
  if (clientSecret && !clientId) {
    throw new ConfigError(`store "${alias}": "clientSecret" is set but "clientId" is missing.`);
  }

  return {
    alias,
    label: str(store.label),
    domain,
    accessToken,
    clientId,
    clientSecret,
    apiVersion: str(store.apiVersion),
  };
}

/** Accept `https://x.myshopify.com/`, `x.myshopify.com`, or bare `x`. */
export function normaliseDomain(input?: string): string | undefined {
  if (!input) return undefined;
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) return undefined;
  if (!domain.includes(".")) domain = `${domain}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
    throw new ConfigError(
      `"${input}" is not a valid store domain. Expected something like "your-store.myshopify.com".`,
    );
  }
  return domain;
}

function aliasFromDomain(domain?: string): string {
  if (!domain) return "default";
  const host = domain.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  const first = host.split(".")[0] ?? "";
  const cleaned = first.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return ALIAS_PATTERN.test(cleaned) ? cleaned : "default";
}

function normaliseDefaultStore(
  parsed: StoresFile,
  stores: StoreConfig[],
  argv: Argv,
  env: Env,
  source: string,
): string | undefined {
  const requested = (
    str(argv.defaultStore) ??
    env.SHOPIFY_DEFAULT_STORE ??
    parsed.defaultStore
  )?.toLowerCase();

  if (!requested) {
    // With exactly one store there is nothing to choose; make it active so
    // single-store users never see a "which store?" prompt.
    return stores.length === 1 ? stores[0]!.alias : undefined;
  }

  if (!stores.some((s) => s.alias === requested)) {
    throw new ConfigError(
      `defaultStore "${requested}" does not match any configured store (${source}). Known aliases: ${stores
        .map((s) => s.alias)
        .join(", ")}.`,
    );
  }
  return requested;
}

// ── small helpers ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}
