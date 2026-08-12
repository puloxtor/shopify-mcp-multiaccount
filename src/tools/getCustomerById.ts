import { gql } from "../lib/gql.js";
import { z } from "zod";
import { toNumericId, handleToolError, edgesToNodes, type ToolContext } from "../lib/toolUtils.js";

// Input schema for getting a customer by ID
const GetCustomerByIdInputSchema = z.object({
  id: z.string().describe("Customer ID — numeric (\"6276879810626\") or GID (\"gid://shopify/Customer/6276879810626\"), as returned by get-customers")
});

type GetCustomerByIdInput = z.infer<typeof GetCustomerByIdInputSchema>;

const getCustomerById = {
  name: "get-customer-by-id",
  description: "Get a single customer by ID",
  schema: GetCustomerByIdInputSchema,

  execute: async (input: GetCustomerByIdInput, ctx: ToolContext) => {
    try {
      const id = toNumericId(input.id, "Customer");

      // Convert numeric ID to GID format
      const customerGid = `gid://shopify/Customer/${id}`;

      const query = gql`
        #graphql

        query GetCustomerById($id: ID!) {
          customer(id: $id) {
            id
            firstName
            lastName
            defaultEmailAddress {
              emailAddress
            }
            defaultPhoneNumber {
              phoneNumber
            }
            createdAt
            updatedAt
            tags
            note
            taxExempt
            defaultAddress {
              address1
              address2
              city
              provinceCode
              zip
              country
              phone
            }
            addressesV2(first: 10) {
              edges {
                node {
                  address1
                  address2
                  city
                  provinceCode
                  zip
                  country
                  phone
                }
              }
            }
            amountSpent {
              amount
              currencyCode
            }
            numberOfOrders
            metafields(first: 10) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      `;

      const variables = {
        id: customerGid
      };

      const data = (await ctx.client.request(query, variables)) as {
        customer: any;
      };

      if (!data.customer) {
        throw new Error(`Customer with ID ${id} not found`);
      }

      const customer = data.customer;

      // Format metafields if they exist
      const metafields = customer.metafields
        ? edgesToNodes(customer.metafields)
        : [];
      const addresses = customer.addressesV2
        ? edgesToNodes(customer.addressesV2)
        : [];

      return {
        customer: {
          id: customer.id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.defaultEmailAddress?.emailAddress || null,
          phone: customer.defaultPhoneNumber?.phoneNumber || null,
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
          tags: customer.tags,
          note: customer.note,
          taxExempt: customer.taxExempt,
          defaultAddress: customer.defaultAddress,
          addresses,
          amountSpent: customer.amountSpent,
          numberOfOrders: customer.numberOfOrders,
          metafields
        }
      };
    } catch (error) {
      handleToolError("fetch customer", error);
    }
  }
};

export { getCustomerById };
