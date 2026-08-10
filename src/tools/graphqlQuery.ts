import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GraphqlQueryInputSchema = z.object({
  query: z.string().describe("A raw Shopify Admin GraphQL query document (the `query { ... }` block)."),
  variables: z.record(z.unknown()).optional().describe("Variables for the query, if it declares any."),
});

type GraphqlQueryInput = z.infer<typeof GraphqlQueryInputSchema>;

let shopifyClient: GraphQLClient;

const graphqlQuery = {
  name: "graphql-query",
  description:
    "Run a raw read-only query against the Shopify Admin GraphQL API, for resources with no dedicated tool (e.g. `currentAppInstallation { accessScopes { handle } }` to check what scopes are actually granted, gift cards, translations, markets details, etc). Prefer a dedicated tool when one exists.",
  schema: GraphqlQueryInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GraphqlQueryInput) => {
    try {
      return await shopifyClient.request(input.query, input.variables ?? {});
    } catch (error) {
      handleToolError("run GraphQL query", error);
    }
  },
};

export { graphqlQuery };
