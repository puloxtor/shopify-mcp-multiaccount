/**
 * Minimal GraphQL template tag.
 *
 * Kept deliberately identical in behaviour to `graphql-request`'s `gql` (it
 * just joins the template into a string) so that:
 *   - the 40+ existing tool documents need no rewriting, and
 *   - `graphql-codegen` / `graphql-tag-pluck` keeps discovering documents by
 *     the `gql` identifier name (see `.graphqlrc.ts`).
 */
export function gql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += String(values[i]) + (strings[i + 1] ?? "");
  }
  return out;
}
