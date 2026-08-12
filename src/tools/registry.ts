import type { ShopifyTool, ToolAnnotations } from "../lib/toolUtils.js";

// Store management (multi-account)
import { listStores } from "./listStores.js";
import { switchStore } from "./switchStore.js";

// Product tools
import { getProducts } from "./getProducts.js";
import { getProductById } from "./getProductById.js";
import { createProduct } from "./createProduct.js";
import { updateProduct } from "./updateProduct.js";
import { deleteProduct } from "./deleteProduct.js";
import { manageProductVariants } from "./manageProductVariants.js";
import { deleteProductVariants } from "./deleteProductVariants.js";
import { manageProductOptions } from "./manageProductOptions.js";

// Order tools
import { getOrders } from "./getOrders.js";
import { getOrderById } from "./getOrderById.js";
import { updateOrder } from "./updateOrder.js";
import { createDraftOrder } from "./createDraftOrder.js";
import { completeDraftOrder } from "./completeDraftOrder.js";
import { orderCancel } from "./orderCancel.js";
import { orderCloseOpen } from "./orderCloseOpen.js";
import { orderMarkAsPaid } from "./orderMarkAsPaid.js";
import { createFulfillment } from "./createFulfillment.js";
import { createRefund } from "./createRefund.js";

// Customer tools
import { getCustomers } from "./getCustomers.js";
import { getCustomerById } from "./getCustomerById.js";
import { getCustomerOrders } from "./getCustomerOrders.js";
import { createCustomer } from "./createCustomer.js";
import { updateCustomer } from "./updateCustomer.js";
import { deleteCustomer } from "./deleteCustomer.js";
import { mergeCustomers } from "./mergeCustomers.js";
import { manageCustomerAddress } from "./manageCustomerAddress.js";

// Metafield tools
import { getMetafields } from "./getMetafields.js";
import { setMetafields } from "./setMetafields.js";
import { deleteMetafields } from "./deleteMetafields.js";

// Convenience / cross-resource tools
import { manageTags } from "./manageTags.js";
import { setInventoryQuantities } from "./setInventoryQuantities.js";

// Configuration & discovery tools
import { getShopInfo } from "./getShopInfo.js";
import { getMetafieldDefinitions } from "./getMetafieldDefinitions.js";
import { getLocations } from "./getLocations.js";
import { getMarkets } from "./getMarkets.js";
import { getCollections } from "./getCollections.js";

// Enhanced order & fulfillment tools
import { getOrderTransactions } from "./getOrderTransactions.js";
import { getFulfillmentOrders } from "./getFulfillmentOrders.js";
import { getOrderRefundDetails } from "./getOrderRefundDetails.js";
import { getCollectionById } from "./getCollectionById.js";

// Inventory & pricing read tools
import { getInventoryLevels } from "./getInventoryLevels.js";
import { getInventoryItems } from "./getInventoryItems.js";
import { getPriceLists } from "./getPriceLists.js";
import { getProductVariantsDetailed } from "./getProductVariantsDetailed.js";

/**
 * Tools that can destroy or irreversibly alter data.
 *
 * Two things key off this list:
 *   - `annotations.destructiveHint`, surfaced to the MCP client, and
 *   - the `store` argument becoming **required** when more than one store is
 *     configured, so a destructive write can never silently inherit whichever
 *     store happened to be active.
 */
export const DESTRUCTIVE_TOOLS = new Set([
  "delete-product",
  "delete-product-variants",
  "delete-customer",
  "delete-metafields",
  "order-cancel",
  "refund-create",
  "customer-merge",
  "complete-draft-order",
  "create-fulfillment",
  "order-mark-as-paid",
  "inventory-set-quantities",
]);

/** Annotations for tools that do not declare their own. */
export function annotationsFor(name: string): ToolAnnotations {
  if (DESTRUCTIVE_TOOLS.has(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  }
  if (name.startsWith("get-")) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  }
  return { readOnlyHint: false, destructiveHint: false };
}

export const tools: ShopifyTool[] = [
  // Store management (2)
  listStores,
  switchStore,
  // Products (8)
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  manageProductVariants,
  deleteProductVariants,
  manageProductOptions,
  // Orders (10)
  getOrders,
  getOrderById,
  updateOrder,
  createDraftOrder,
  completeDraftOrder,
  orderCancel,
  orderCloseOpen,
  orderMarkAsPaid,
  createFulfillment,
  createRefund,
  // Customers (8)
  getCustomers,
  getCustomerById,
  getCustomerOrders,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  mergeCustomers,
  manageCustomerAddress,
  // Metafields (3)
  getMetafields,
  setMetafields,
  deleteMetafields,
  // Convenience (2)
  manageTags,
  setInventoryQuantities,
  // Configuration & discovery (5)
  getShopInfo,
  getMetafieldDefinitions,
  getLocations,
  getMarkets,
  getCollections,
  // Enhanced order & fulfillment (4)
  getOrderTransactions,
  getFulfillmentOrders,
  getOrderRefundDetails,
  getCollectionById,
  // Inventory & pricing reads (4)
  getInventoryLevels,
  getInventoryItems,
  getPriceLists,
  getProductVariantsDetailed,
];
