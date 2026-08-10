/**
 * Parsing and validation for the SHOPIFY_STORES multi-store config.
 *
 * SHOPIFY_STORES holds a JSON array of store objects, e.g.:
 *   [
 *     { "name": "store-a", "domain": "store-a.myshopify.com", "accessToken": "shpat_xxx" },
 *     { "name": "store-b", "domain": "store-b.myshopify.com", "clientId": "abc", "clientSecret": "def" }
 *   ]
 */

import { z } from "zod";

export const StoreEntrySchema = z
  .object({
    name: z.string().trim().min(1, 'each store must have a non-empty "name"'),
    domain: z
      .string()
      .trim()
      .min(1, 'each store must have a non-empty "domain"')
      .regex(/\.myshopify\.com$/i, '"domain" must end with .myshopify.com'),
    accessToken: z.string().trim().min(1).optional(),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional(),
    default: z.boolean().optional(),
  })
  .strict()
  .superRefine((store, ctx) => {
    const hasToken = !!store.accessToken;
    const hasId = !!store.clientId;
    const hasSecret = !!store.clientSecret;

    if (hasToken && (hasId || hasSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Store "${store.name}": provide either "accessToken" or "clientId"+"clientSecret", not both.`,
      });
    } else if (hasId !== hasSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Store "${store.name}": "clientId" and "clientSecret" must both be set together.`,
      });
    } else if (!hasToken && !hasId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Store "${store.name}": must provide either "accessToken" or "clientId"+"clientSecret".`,
      });
    }
  });

export type StoreEntry = z.infer<typeof StoreEntrySchema>;

export const StoresConfigSchema = z
  .array(StoreEntrySchema)
  .min(1, "SHOPIFY_STORES must be a non-empty JSON array of store objects")
  .superRefine((stores, ctx) => {
    const seen = new Map<string, number>();
    stores.forEach((store, index) => {
      if (seen.has(store.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "name"],
          message: `Duplicate store name "${store.name}" at index ${index} (first seen at index ${seen.get(
            store.name,
          )}). Store names must be unique.`,
        });
      } else {
        seen.set(store.name, index);
      }
    });

    const defaults = stores.filter((store) => store.default);
    if (defaults.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Only one store may have "default": true (found ${defaults.length}: ${defaults
          .map((store) => store.name)
          .join(", ")}).`,
      });
    }
  });

/**
 * Parse and validate the raw SHOPIFY_STORES env var value.
 * Throws a single Error listing every problem found.
 */
export function parseStoresConfig(raw: string): StoreEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `SHOPIFY_STORES is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = StoresConfigSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`SHOPIFY_STORES is invalid:\n${details}`);
  }

  return result.data;
}
