# Shopify MCP Server — Multi-Account

An MCP server for the Shopify Admin GraphQL API that manages **many stores from a single server process** and lets you switch between them mid-conversation.

Forked from [GeLi2001/shopify-mcp](https://github.com/GeLi2001/shopify-mcp), which is single-store.

## Why one server instead of one per store

The obvious way to reach several stores is to register the single-store server once per store. That falls down quickly:

- Every store adds a **full duplicate copy of all 44 tools** to the model's context (~8k tokens each), with identical names distinguished only by a server prefix.
- Nothing tells the model *which* store a tool acts on, so a destructive call can land on the wrong store with no trace in the response.
- Each server resolves its credentials at startup, so one unreachable store takes its whole server down — opaquely.

This fork registers the tool set **once**, adds a store dimension to it, and stamps every response with the store it came from.

## Features

- **Multiple stores, one server**: configure any number of stores; the tool list is registered once regardless of how many.
- **Seamless switching**: `switch-store` changes the active store for the rest of the conversation; every tool also takes an optional `store` argument to redirect a single call without switching.
- **Store provenance on every response**: results carry `{"store": {"alias": …, "domain": …}}` so the model can always see where it just acted.
- **Guard rails on destructive calls**: when more than one store is configured, irreversible tools (`order-cancel`, `delete-product`, `refund-create`, …) *require* an explicit `store`.
- **Lazy, isolated connections**: stores connect on first use, so a misconfigured store never blocks the server or the other stores.
- **Resilient transport**: request timeouts, retry with backoff on 429/5xx/network errors, automatic retry on Shopify's `THROTTLED` rate-limit error, and one transparent token refresh on 401.
- **Sleep-safe auth**: OAuth tokens are validated on the request path, not by a background timer, so suspending the machine doesn't leave the server serving 401s.
- **Product / Customer / Order / Metafield / Inventory management**: 44 tools over the Admin GraphQL API (2026-01).

## Prerequisites

1. Node.js 18.17 or newer
2. One Shopify custom app per store (see below)

## Setup

### 1. Get credentials for each store

**Client Credentials (Dev Dashboard apps, January 2026+)** — as of January 1 2026, new Shopify apps are created in the Dev Dashboard and issue OAuth client credentials rather than static tokens.

1. In Shopify admin: **Settings → Apps and sales channels → Develop apps → Build app in dev dashboard**
2. Configure **Admin API scopes** (`read_products`, `write_products`, `read_customers`, `write_customers`, `read_orders`, `write_orders`, plus any others you need)
3. Install the app on the store
4. Copy the **Client ID** and **Client Secret**

The server exchanges these for a short-lived access token and refreshes it automatically.

**Static Access Token (legacy apps)** — an existing custom app's `shpat_…` token still works; use `accessToken` instead of the client ID/secret pair.

### 2. Write a store config

Create `shopify-stores.json` (this filename is gitignored):

```json
{
  "defaultStore": "acme",
  "stores": [
    {
      "alias": "acme",
      "label": "ACME Retail (production)",
      "domain": "acme.myshopify.com",
      "clientId": "${ACME_CLIENT_ID}",
      "clientSecret": "${ACME_CLIENT_SECRET}"
    },
    {
      "alias": "widgets",
      "label": "Widgets EU",
      "domain": "widgets-eu.myshopify.com",
      "accessToken": "${WIDGETS_ACCESS_TOKEN}"
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `alias` | no | Short handle used to target the store. Defaults to the domain's subdomain. Lowercase letters, digits, `-`, `_`. |
| `domain` | **yes** | `your-store.myshopify.com`. A bare `your-store` is expanded; a full URL is trimmed. |
| `label` | no | Human name, also usable as a switch target. |
| `accessToken` | one of | Legacy static token. |
| `clientId` + `clientSecret` | one of | Dev Dashboard client credentials. |
| `apiVersion` | no | Per-store override of the default (`2026-01`). |

Any string may reference an environment variable as `${VAR_NAME}`, so the file can be committed while secrets stay in the environment. A missing variable is a startup error naming the variable — never a silent empty credential.

`defaultStore` sets the store that is active when the server starts. Omit it and, with more than one store configured, the model must call `switch-store` or pass `store` explicitly.

See [`shopify-stores.example.json`](./shopify-stores.example.json).

### 3. Install

This fork is not published to npm, so `npx shopify-mcp-multiaccount` will not resolve. Build it from a clone and reference `dist/index.js` by absolute path:

```bash
git clone https://github.com/puloxtor/shopify-mcp-multiaccount.git
cd shopify-mcp-multiaccount
npm install
npm run build
npm test          # optional: verifies the build end to end, no network needed
```

To get the `npx` form in the examples below, publish it under your own npm scope (`npm publish`) or link it locally with `npm link`.

### 4. Register the server

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "shopify": {
      "command": "node",
      "args": [
        "/absolute/path/to/shopify-mcp-multiaccount/dist/index.js",
        "--stores=/absolute/path/to/shopify-stores.json"
      ],
      "env": {
        "ACME_CLIENT_ID": "…",
        "ACME_CLIENT_SECRET": "…",
        "WIDGETS_ACCESS_TOKEN": "shpat_…"
      }
    }
  }
}
```

The MCP client does **not** inherit your shell environment, so every `${VAR}` referenced by the store config must be listed under `env` here.

Once published, the same config via `npx`:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["shopify-mcp-multiaccount", "--stores=/absolute/path/to/shopify-stores.json"],
      "env": {
        "ACME_CLIENT_ID": "…",
        "ACME_CLIENT_SECRET": "…",
        "WIDGETS_ACCESS_TOKEN": "shpat_…"
      }
    }
  }
}
```

Use an **absolute** path for `--stores`; the server's working directory is not your project directory.

**Claude Code:**

```bash
claude mcp add shopify -- node /absolute/path/to/shopify-mcp-multiaccount/dist/index.js \
  --stores=/absolute/path/to/shopify-stores.json
```

### Configuration sources

Resolved in this order — the first that yields anything wins:

1. `--stores=<path>` or `SHOPIFY_STORES_FILE` — path to the JSON config
2. `SHOPIFY_STORES` — the same JSON, inline
3. Legacy single-store flags (below)

### Single store

The original flags still work unchanged, and no multi-store concepts appear in the tool schemas when only one store is configured:

```bash
node dist/index.js --domain=your-store.myshopify.com --accessToken=shpat_xxx
node dist/index.js --domain=your-store.myshopify.com --clientId=… --clientSecret=…
```

Or via `.env` / environment: `MYSHOPIFY_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, or `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.

### Additional options

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| `--stores` | `SHOPIFY_STORES_FILE` | — | Path to the store config file |
| — | `SHOPIFY_STORES` | — | Store config as inline JSON |
| `--defaultStore` | `SHOPIFY_DEFAULT_STORE` | single store, else none | Store active at startup |
| `--apiVersion` | `SHOPIFY_API_VERSION` | `2026-01` | Admin API version |

## Working with multiple stores

Three ways to target a store, in precedence order:

1. **Explicit per call** — `get-orders` with `store: "widgets"`. Does not change the active store.
2. **Active store** — set by `switch-store`, or by `defaultStore` at startup.
3. **Implicit** — with exactly one store configured, it is always the target.

`switch-store` verifies credentials against the live API *before* switching and returns the shop's real name, so a switch either lands somewhere confirmed or leaves the active store untouched. Store targets can be given as an alias, a full domain, a label, or an unambiguous prefix of any of them.

Destructive tools require an explicit `store` whenever more than one store is configured, so "cancel that order" can never silently resolve to the wrong shop.

## Available Tools (46)

Every store-scoped tool below additionally accepts an optional `store` argument (alias, domain, or label) when more than one store is configured.

### Store Management (2 tools)

1. **`list-stores`**

   - List every configured store with its alias, domain, auth mode, and which one is active. Makes no API calls, so it works even when credentials are wrong.
   - Inputs: none
   - Returns: `activeStore`, `storeCount`, and a `stores` array

2. **`switch-store`**

   - Make a different store active for subsequent calls. Verifies credentials against the Shopify API first; on failure the active store is left unchanged.
   - Inputs:
     - `store` (string, required): Alias, full domain, or label of the target store
   - Returns: `activeStore`, `previousStore`, `shopName`, `currencyCode`, `timezone`

### Pagination, Sorting & Filtering

All list query tools (`get-products`, `get-customers`, `get-orders`, `get-customer-orders`) support:

- **Cursor-based pagination**: `after` / `before` (cursor strings), with `pageInfo` in the response (`hasNextPage`, `hasPreviousPage`, `startCursor`, `endCursor`)
- **Sorting**: `sortKey` (enum specific to each resource) and `reverse` (boolean)
- **Advanced filtering**: `query` or `searchQuery` parameter accepting [Shopify query syntax](https://shopify.dev/docs/api/usage/search-syntax)

### Product Management (8 tools)

1. **`get-products`**

   - Get all products or search by title with pagination and sorting
   - Inputs:
     - `searchTitle` (string, optional): Filter products by title (wraps in `title:*...*`)
     - `limit` (number, default: 10, max: 250): Maximum number of products to return
     - `query` (string, optional): Raw Shopify query string (e.g. `"status:active vendor:Nike tag:sale"`)
     - `sortKey` (string, optional): One of `CREATED_AT`, `ID`, `INVENTORY_TOTAL`, `PRODUCT_TYPE`, `PUBLISHED_AT`, `RELEVANCE`, `TITLE`, `UPDATED_AT`, `VENDOR`
     - `reverse` (boolean, optional): Reverse the sort order
     - `after` / `before` (string, optional): Pagination cursors

2. **`get-product-by-id`**

   - Get a specific product by ID with full details including SEO, options, media, variants, and collections
   - Inputs:
     - `productId` (string, required): Shopify product GID
   - Returns: `productType`, `descriptionHtml`, `seo`, `options` (with `optionValues`), `media` (images), `variants`, `collections`, `tags`, `vendor`, price range, inventory

3. **`create-product`**

   - Create a new product. When using `productOptions`, Shopify registers all option values but only creates one default variant (first value of each option, price $0). Use `manage-product-variants` with `strategy: REMOVE_STANDALONE_VARIANT` afterward to create all real variants with prices.
   - Inputs:
     - `title` (string, required): Title of the product
     - `descriptionHtml` (string, optional): Description with HTML
     - `handle` (string, optional): URL slug. Auto-generated from title if omitted
     - `vendor` (string, optional): Vendor of the product
     - `productType` (string, optional): Type of the product
     - `tags` (array of strings, optional): Product tags
     - `status` (string, optional): `"ACTIVE"`, `"DRAFT"`, or `"ARCHIVED"`. Default `"DRAFT"`
     - `seo` (object, optional): `{ title, description }` for search engines
     - `metafields` (array of objects, optional): Custom metafields (`namespace`, `key`, `value`, `type`)
     - `productOptions` (array of objects, optional): Options to create inline, e.g. `[{ name: "Size", values: [{ name: "S" }, { name: "M" }] }]`. Max 3 options.
     - `collectionsToJoin` (array of strings, optional): Collection GIDs to add the product to

4. **`update-product`**

   - Update an existing product's fields
   - Inputs:
     - `id` (string, required): Shopify product GID
     - `title` (string, optional): New title
     - `descriptionHtml` (string, optional): New description
     - `handle` (string, optional): New URL slug
     - `vendor` (string, optional): New vendor
     - `productType` (string, optional): New product type
     - `tags` (array of strings, optional): New tags (overwrites existing)
     - `status` (string, optional): `"ACTIVE"`, `"DRAFT"`, or `"ARCHIVED"`
     - `seo` (object, optional): `{ title, description }` for search engines
     - `metafields` (array of objects, optional): Metafields to set or update
     - `collectionsToJoin` (array of strings, optional): Collection GIDs to add the product to
     - `collectionsToLeave` (array of strings, optional): Collection GIDs to remove the product from
     - `redirectNewHandle` (boolean, optional): If true, old handle redirects to new handle

5. **`delete-product`**

   - Delete a product
   - Inputs:
     - `id` (string, required): Shopify product GID

6. **`manage-product-options`**

   - Create, update, or delete product options (e.g. Size, Color)
   - Inputs:
     - `productId` (string, required): Shopify product GID
     - `action` (string, required): `"create"`, `"update"`, or `"delete"`
     - `variantStrategy` (string, optional): `"LEAVE_AS_IS"` (default) or `"CREATE"` — controls whether new variant combinations are generated when adding options
     - For `action: "create"`:
       - `options` (array, required): Options to create, e.g. `[{ name: "Size", values: ["S", "M", "L"] }]`
     - For `action: "update"`:
       - `optionId` (string, required): Option GID to update
       - `name` (string, optional): New name for the option
       - `position` (number, optional): New position
       - `valuesToAdd` (array of strings, optional): Values to add
       - `valuesToDelete` (array of strings, optional): Value GIDs to remove
     - For `action: "delete"`:
       - `optionIds` (array of strings, required): Option GIDs to delete

7. **`manage-product-variants`**

   - Create or update product variants in bulk
   - Inputs:
     - `productId` (string, required): Shopify product GID
     - `strategy` (string, optional): How to handle the default variant when creating. `"DEFAULT"` (removes "Default Title" automatically), `"REMOVE_STANDALONE_VARIANT"` (recommended for full control), or `"PRESERVE_STANDALONE_VARIANT"`
     - `variants` (array, required): Variants to create or update. Each variant:
       - `id` (string, optional): Variant GID for updates. Omit to create new
       - `price` (string, optional): Price, e.g. `"49.00"`
       - `compareAtPrice` (string, optional): Compare-at price for showing discounts
       - `sku` (string, optional): SKU (mapped to `inventoryItem.sku`)
       - `tracked` (boolean, optional): Whether inventory is tracked. Set `false` for print-on-demand
       - `taxable` (boolean, optional): Whether the variant is taxable
       - `barcode` (string, optional): Barcode
       - `weight` (number, optional): Weight of the variant
       - `weightUnit` (string, optional): `"GRAMS"`, `"KILOGRAMS"`, `"OUNCES"`, or `"POUNDS"`
       - `optionValues` (array, optional): Option values, e.g. `[{ optionName: "Size", name: "A4" }]`

8. **`delete-product-variants`**

   - Delete one or more variants from a product
   - Inputs:
     - `productId` (string, required): Shopify product GID
     - `variantIds` (array of strings, required): Variant GIDs to delete

### Customer Management (8 tools)

1. **`get-customers`**

   - List customers with search, pagination, and sorting
   - Inputs:
     - `searchQuery` (string, optional): Freetext or Shopify query syntax (e.g. `"country:US tag:vip orders_count:>5"`)
     - `limit` (number, default: 10, max: 250): Maximum number of customers to return
     - `sortKey` (string, optional): One of `CREATED_AT`, `ID`, `LAST_UPDATE`, `LOCATION`, `NAME`, `ORDERS_COUNT`, `RELEVANCE`, `TOTAL_SPENT`, `UPDATED_AT`
     - `reverse` (boolean, optional): Reverse the sort order
     - `after` / `before` (string, optional): Pagination cursors

2. **`get-customer-by-id`**

   - Get a single customer by ID with full details
   - Inputs:
     - `id` (string, required): Shopify customer ID — numeric (`"6276879810626"`) or GID (`"gid://shopify/Customer/6276879810626"`)
   - Returns: name, email, phone, addresses, tags, note, tax status, amount spent, order count, metafields

3. **`create-customer`**

   - Create a new customer
   - Inputs:
     - `firstName` (string, optional): Customer's first name
     - `lastName` (string, optional): Customer's last name
     - `email` (string, optional): Customer's email address
     - `phone` (string, optional): Customer's phone number
     - `tags` (array of strings, optional): Tags to apply
     - `note` (string, optional): Note about the customer
     - `taxExempt` (boolean, optional): Whether the customer is exempt from taxes
     - `metafields` (array of objects, optional): Custom metafields (`namespace`, `key`, `value`, `type`)
     - `addresses` (array of objects, optional): Customer addresses (`address1`, `address2`, `city`, `provinceCode`, `zip`, `country`, `phone`)

4. **`update-customer`**

   - Update a customer's information
   - Inputs:
     - `id` (string, required): Shopify customer ID — numeric (`"6276879810626"`) or GID (`"gid://shopify/Customer/6276879810626"`)
     - `firstName` (string, optional): Customer's first name
     - `lastName` (string, optional): Customer's last name
     - `email` (string, optional): Customer's email address
     - `phone` (string, optional): Customer's phone number
     - `tags` (array of strings, optional): Tags to apply to the customer
     - `note` (string, optional): Note about the customer
     - `taxExempt` (boolean, optional): Whether the customer is exempt from taxes
     - `emailMarketingConsent` (object, optional): Email marketing consent settings
       - `marketingState` (string, required): `"NOT_SUBSCRIBED"`, `"SUBSCRIBED"`, `"UNSUBSCRIBED"`, or `"PENDING"`
       - `consentUpdatedAt` (string, optional): ISO 8601 timestamp
       - `marketingOptInLevel` (string, optional): `"SINGLE_OPT_IN"`, `"CONFIRMED_OPT_IN"`, or `"UNKNOWN"`
     - `metafields` (array of objects, optional): Customer metafields

5. **`delete-customer`**

   - Delete a customer
   - Inputs:
     - `id` (string, required): Shopify customer ID — numeric (`"6276879810626"`) or GID (`"gid://shopify/Customer/6276879810626"`)

6. **`customer-merge`**

   - Merge two customer records into one
   - Inputs:
     - `customerOneId` (string, required): GID of the first customer
     - `customerTwoId` (string, required): GID of the second customer
     - `overrideFields` (object, optional): Override which fields to keep from which customer (firstName, lastName, email, phone, defaultAddress, note, tags)

7. **`manage-customer-address`**

   - Create, update, or delete a customer's mailing address
   - Inputs:
     - `customerId` (string, required): Customer GID
     - `action` (string, required): `"create"`, `"update"`, or `"delete"`
     - `addressId` (string, optional): Address GID (required for update/delete)
     - `address` (object, optional): Address fields (required for create/update): `address1`, `address2`, `city`, `company`, `countryCode`, `firstName`, `lastName`, `phone`, `provinceCode`, `zip`
     - `setAsDefault` (boolean, optional): Set as customer's default address

### Order Management (10 tools)

1. **`get-orders`**

   - Get orders with filtering, pagination, and sorting
   - Inputs:
     - `status` (string, optional): `"any"`, `"open"`, `"closed"`, or `"cancelled"`. Default `"any"`
     - `limit` (number, default: 10, max: 250): Maximum number of orders to return
     - `query` (string, optional): Raw Shopify query string (e.g. `"financial_status:paid fulfillment_status:shipped tag:rush"`)
     - `sortKey` (string, optional): One of `CREATED_AT`, `ORDER_NUMBER`, `TOTAL_PRICE`, `FINANCIAL_STATUS`, `FULFILLMENT_STATUS`, `UPDATED_AT`, `CUSTOMER_NAME`, `PROCESSED_AT`, `ID`, `RELEVANCE`
     - `reverse` (boolean, optional): Reverse the sort order
     - `after` / `before` (string, optional): Pagination cursors

2. **`get-order-by-id`**

   - Get a specific order by ID with smart lookup — accepts order name (`#77235` or `77235`), numeric ID (`8054938337547`), or full GID (`gid://shopify/Order/...`)
   - Inputs:
     - `orderId` (string, required): Order name, numeric ID, or full GID
   - Returns: pricing, customer, shipping/billing addresses, line items, tags, notes, metafields, cancel reason, return status, discount codes, PO number, timestamps

3. **`update-order`**

   - Update an existing order
   - Inputs:
     - `id` (string, required): Shopify order GID
     - `tags` (array of strings, optional): New tags for the order
     - `email` (string, optional): Update customer email on the order
     - `note` (string, optional): Order notes
     - `phone` (string, optional): Phone number for the order
     - `poNumber` (string, optional): Purchase order number
     - `customAttributes` (array of objects, optional): Custom key-value attributes
     - `metafields` (array of objects, optional): Order metafields
     - `shippingAddress` (object, optional): Shipping address fields

4. **`get-customer-orders`**

   - Get orders for a specific customer with pagination and sorting
   - Inputs:
     - `customerId` (string, required): Shopify customer ID — numeric (`"6276879810626"`) or GID (`"gid://shopify/Customer/6276879810626"`)
     - `limit` (number, default: 10, max: 250): Maximum number of orders to return
     - `sortKey` (string, optional): Same sort keys as `get-orders`
     - `reverse` (boolean, optional): Reverse the sort order
     - `after` / `before` (string, optional): Pagination cursors

5. **`order-cancel`**

   - Cancel an order with options for refunding, restocking, and customer notification. **Irreversible.**
   - Inputs:
     - `orderId` (string, required): Order GID
     - `reason` (string, required): `"CUSTOMER"`, `"DECLINED"`, `"FRAUD"`, `"INVENTORY"`, `"OTHER"`, or `"STAFF"`
     - `restock` (boolean, required): Whether to restock inventory
     - `notifyCustomer` (boolean, default: false): Notify the customer
     - `staffNote` (string, optional): Internal note
     - `refund` (boolean, optional): Refund to original payment method

6. **`order-close-open`**

   - Close or reopen an order
   - Inputs:
     - `orderId` (string, required): Order GID
     - `action` (string, required): `"close"` or `"open"`

7. **`order-mark-as-paid`**

   - Mark an order as paid (for manual/offline payments)
   - Inputs:
     - `orderId` (string, required): Order GID

8. **`create-fulfillment`**

   - Create a fulfillment (mark items as shipped) with optional tracking
   - Inputs:
     - `lineItemsByFulfillmentOrder` (array, required): Fulfillment orders and line items to fulfill
     - `trackingInfo` (object, optional): `{ number, url, company }` tracking details
     - `notifyCustomer` (boolean, default: false): Send shipping notification

9. **`refund-create`**

   - Create a full or partial refund with optional restocking
   - Inputs:
     - `orderId` (string, required): Order GID
     - `refundLineItems` (array, optional): Line items to refund with `lineItemId`, `quantity`, `restockType` (`CANCEL`/`RETURN`/`NO_RESTOCK`), `locationId`
     - `shipping` (object, optional): `{ amount, fullRefund }` shipping refund
     - `note` (string, optional): Refund note
     - `notify` (boolean, optional): Send refund notification

10. **`create-draft-order`**

    - Create a draft order for phone/chat sales, invoicing, or wholesale
    - Inputs:
      - `lineItems` (array, required): Product variants (`variantId`) or custom items (`title` + price). Max 499
      - `customerId` (string, optional): Customer GID
      - `email`, `phone`, `note`, `tags`, `poNumber` (optional)
      - `shippingAddress`, `billingAddress` (objects, optional)
      - `appliedDiscount` (object, optional): `{ title, value, valueType }` order-level discount

### Draft Order Management (1 tool)

1. **`complete-draft-order`**

   - Complete a draft order, converting it into a real order
   - Inputs:
     - `draftOrderId` (string, required): Draft order GID
     - `paymentGatewayId` (string, optional): Payment gateway GID

### Metafield Management (3 tools)

1. **`get-metafields`**

   - Get metafields for any Shopify resource (products, orders, customers, variants, collections, etc.)
   - Inputs:
     - `ownerId` (string, required): GID of any resource
     - `namespace` (string, optional): Filter by namespace
     - `first` (number, default: 25, max: 50): Number of metafields to return
     - `after` (string, optional): Pagination cursor

2. **`set-metafields`**

   - Set metafields on any Shopify resource. Creates or updates up to 25 metafields atomically
   - Inputs:
     - `metafields` (array, required): Metafields to set, each with `ownerId`, `key`, `value`, and optional `namespace`, `type`

3. **`delete-metafields`**

   - Delete metafields from any Shopify resource
   - Inputs:
     - `metafields` (array, required): Metafields to delete, each with `ownerId`, `namespace`, `key`

### Inventory Management (1 tool)

1. **`inventory-set-quantities`**

   - Set absolute inventory quantities for items at specific locations
   - Inputs:
     - `reason` (string, required): Reason for change (e.g. `"correction"`, `"cycle_count_available"`)
     - `name` (string, required): `"available"` or `"on_hand"`
     - `quantities` (array, required): Items with `inventoryItemId`, `locationId`, `quantity`

### Tag Management (1 tool)

1. **`manage-tags`**

   - Add or remove tags on any taggable resource (orders, products, customers, draft orders, articles)
   - Inputs:
     - `id` (string, required): GID of the resource
     - `tags` (array of strings, required): Tags to add or remove
     - `action` (string, required): `"add"` or `"remove"`

### Order Query Filter Reference

The `get-orders` tool's `query` parameter supports [Shopify search syntax](https://shopify.dev/docs/api/usage/search-syntax):

| Filter | Example |
|--------|---------|
| `name` | `name:#77235` |
| `created_at` | `created_at:>2024-01-01` or `created_at:2024-01-01..2024-03-31` |
| `updated_at` | `updated_at:>2024-06-01` |
| `financial_status` | `financial_status:paid` |
| `fulfillment_status` | `fulfillment_status:shipped` |
| `status` | `status:open` |
| `email` | `email:customer@example.com` |
| `tag` / `tag_not` | `tag:vip tag_not:wholesale` |
| `discount_code` | `discount_code:SUMMER20` |
| `sku` | `sku:PROD-001` |
| `risk_level` | `risk_level:high` |
| `gateway` | `gateway:shopify_payments` |
| `test` | `test:true` |

## Troubleshooting

The server writes a startup line to stderr naming the stores it loaded, e.g.:

```
shopify-mcp: 2 store(s) from file /path/to/shopify-stores.json — acme, widgets (active: acme)
```

Claude Desktop's MCP logs:

```
tail -n 50 -f ~/Library/Logs/Claude/mcp*.log
```

| Symptom | Cause and fix |
|---|---|
| Server won't start; log shows `No Shopify stores configured` | The config path was not found or no legacy flags were passed. Use an absolute `--stores` path. |
| Startup error naming a `${VAR}` | The config references an environment variable that isn't set in the MCP client's environment. Add it under `env` in the client config — the server does not inherit your shell. |
| `Unknown store "…"` | The alias doesn't match. Call `list-stores` to see the configured aliases. |
| `Shopify rejected the credentials (HTTP 401/403)` | Wrong token/secret. The message names the store. |
| `get-shop-info` works but **every** other tool returns `Access denied` | The app is installed on that store with no Admin API access scopes. See below. |
| `Access denied for products …` | The app's token lacks that field's scope. The error names the scope and lists what is currently granted. |
| `… does not resolve to a Shopify store (HTTP 404)` | The `domain` is wrong — it must be the `*.myshopify.com` domain, not the storefront domain. |
| `No store selected` | Several stores configured with no `defaultStore`. Use `switch-store`, pass `store` per call, or set `defaultStore`. |
| Rate-limit errors under bulk work | The client already retries `THROTTLED` and 429 with backoff. Persistent failures mean the operation needs smaller pages (`limit`) or fewer parallel calls. |

### Access scopes

A token can be perfectly valid and still be granted nothing. When that happens `get-shop-info` succeeds — reading `shop { … }` needs no scope — while every product, order, customer, collection and location query fails with `ACCESS_DENIED`. It reads like a broken server; it is an app-configuration problem.

`switch-store` reports the granted scopes for the store it switches to, and warns explicitly when the list is empty, so this shows up at switch time rather than as a wall of denials. To check without switching:

```graphql
query { currentAppInstallation { accessScopes { handle } } }
```

An empty array means no scopes are granted. To fix, per store:

- **Custom app (per-store Admin API token)**: Shopify Admin → **Settings → Apps and sales channels → Develop apps → your app → Configuration → Admin API integration**, enable the scopes you need, save, then reinstall/update the app on that store to reissue the token.
- **Dev Dashboard / client-credentials app**: declare the scopes in the app's configuration (`shopify.app.toml` `scopes`, or the Dev Dashboard), release the change, then reinstall the app on the store. There is no merchant re-consent step for the client-credentials grant — the next token exchange picks up the new scopes.

Scopes are baked into a token when it is issued, so changing them never affects tokens already in hand. After fixing, restart the server so a fresh token is exchanged.

Each store has its own installation, so this must be done for each one independently.

Scopes the tools need, at minimum: `read_products`/`write_products`, `read_orders`/`write_orders`, `read_customers`/`write_customers`, `read_draft_orders`/`write_draft_orders`, `read_inventory`/`write_inventory`, `read_locations`, and `read_markets`. The fulfillment and price-list tools need additional scopes — rather than guessing, enable a tool's scope when its first call tells you which one is missing; the error names it.

Verifying a config without an MCP client:

```bash
npm run build
node dist/index.js --stores=/absolute/path/to/shopify-stores.json
# prints the startup line to stderr, then waits for MCP traffic on stdin; Ctrl-C to exit
```

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run build            # compile to dist/
npm test                 # build + end-to-end MCP smoke test (no network required)
npm run validate:graphql # validate every GraphQL document against the live Shopify schema
```

`test/smoke.mjs` drives the built server over real MCP stdio JSON-RPC and covers tool registration and metadata, multi-store targeting, required `store` on destructive tools, unreachable-store handling, and configuration-error exit codes.

## License

MIT
