import type { GraphQLClient } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GraphqlMutationInputSchema = z.object({
  query: z.string().describe("A raw Shopify Admin GraphQL mutation document (the `mutation { ... }` block)."),
  variables: z.record(z.unknown()).optional().describe("Variables for the mutation, if it declares any."),
});

type GraphqlMutationInput = z.infer<typeof GraphqlMutationInputSchema>;

let shopifyClient: GraphQLClient;

const graphqlMutation = {
  name: "graphql-mutation",
  description:
    "Run a raw write mutation against the Shopify Admin GraphQL API, for operations with no dedicated tool. This can make real changes to the connected store -- check userErrors in the response, since Shopify mutations return errors as data rather than throwing. Prefer a dedicated tool when one exists.",
  schema: GraphqlMutationInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GraphqlMutationInput) => {
    try {
      return await shopifyClient.request(input.query, input.variables ?? {});
    } catch (error) {
      handleToolError("run GraphQL mutation", error);
    }
  },
};

export { graphqlMutation };
