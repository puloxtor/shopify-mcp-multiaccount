import { gql } from "../lib/gql.js";
import { z } from "zod";
import { toNumericId, checkUserErrors, handleToolError, type ToolContext } from "../lib/toolUtils.js";

// Input schema for deleting a customer
const DeleteCustomerInputSchema = z.object({
  id: z.string().describe("Customer ID — numeric (\"6276879810626\") or GID (\"gid://shopify/Customer/6276879810626\"), as returned by get-customers")
});

type DeleteCustomerInput = z.infer<typeof DeleteCustomerInputSchema>;

const deleteCustomer = {
  name: "delete-customer",
  description: "Delete a customer",
  schema: DeleteCustomerInputSchema,

  execute: async (input: DeleteCustomerInput, ctx: ToolContext) => {
    try {
      const id = toNumericId(input.id, "Customer");

      // Convert numeric ID to GID format
      const customerGid = `gid://shopify/Customer/${id}`;

      const query = gql`
        #graphql

        mutation customerDelete($input: CustomerDeleteInput!) {
          customerDelete(input: $input) {
            deletedCustomerId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const data = (await ctx.client.request(query, {
        input: { id: customerGid }
      })) as {
        customerDelete: {
          deletedCustomerId: string | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };

      checkUserErrors(data.customerDelete.userErrors, "delete customer");

      return { deletedCustomerId: data.customerDelete.deletedCustomerId };
    } catch (error) {
      handleToolError("delete customer", error);
    }
  }
};

export { deleteCustomer };
