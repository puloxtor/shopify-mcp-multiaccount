#!/usr/bin/env node
/**
 * Transport-level tests for ResilientGraphQLClient against a local stand-in
 * for the Shopify Admin API. Covers the paths that only surface under load or
 * after a long idle — rate limiting, missing access scopes, flaky upstreams —
 * which are exactly the ones impossible to reproduce on demand against the
 * real API.
 */

import { createServer } from "node:http";
import { ResilientGraphQLClient } from "../dist/lib/resilientClient.js";

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function fakeShopify(script) {
  const received = [];
  let index = 0;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ token: req.headers["x-shopify-access-token"], body: JSON.parse(body || "{}") });
      const step = script[Math.min(index++, script.length - 1)];
      if (step.hang) return;
      res.writeHead(step.status ?? 200, { "Content-Type": "application/json", ...(step.headers ?? {}) });
      res.end(typeof step.body === "string" ? step.body : JSON.stringify(step.body));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}/graphql`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeClient(endpoint, overrides = {}) {
  return new ResilientGraphQLClient({
    storeName: "testshop",
    domain: "testshop.myshopify.com",
    apiVersion: "2026-01",
    accessToken: "token-1",
    endpoint,
    ...overrides,
  });
}

const OK = { body: { data: { shop: { name: "Test Shop" } } } };

console.log("\n1. Successful request");
{
  const api = await fakeShopify([OK]);
  const data = await makeClient(api.endpoint).request("query { shop { name } }");
  check("returns the data payload", data?.shop?.name === "Test Shop");
  check("sends the access token", api.received[0].token === "token-1");
  await api.close();
}

console.log("\n2. setHeader hot-swaps the token (as ShopifyAuth relies on)");
{
  const api = await fakeShopify([OK, OK]);
  const client = makeClient(api.endpoint);
  await client.request("query { shop { name } }");
  client.setHeader("X-Shopify-Access-Token", "token-2");
  await client.request("query { shop { name } }");
  check("second request uses the new token", api.received[1].token === "token-2");
  await api.close();
}

console.log("\n3. THROTTLED is retried, then succeeds");
{
  const api = await fakeShopify([
    { body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
    OK,
  ]);
  const data = await makeClient(api.endpoint).request("query { shop { name } }");
  check("recovers after a throttle", data?.shop?.name === "Test Shop");
  check("retried exactly once", api.received.length === 2, `${api.received.length} requests`);
  await api.close();
}

console.log("\n4. HTTP 429 and 5xx are retried");
{
  const api = await fakeShopify([{ status: 429, headers: { "Retry-After": "0" }, body: {} }, { status: 503, body: {} }, OK]);
  const data = await makeClient(api.endpoint).request("query { shop { name } }");
  check("recovers after 429 then 503", data?.shop?.name === "Test Shop");
  check("made three attempts", api.received.length === 3, `${api.received.length} requests`);
  await api.close();
}

console.log("\n5. HTTP 401 fails immediately (no infinite retry, no silent hang)");
{
  const api = await fakeShopify([{ status: 401, body: {} }]);
  let message = "";
  try {
    await makeClient(api.endpoint).request("query { shop { name } }");
  } catch (error) {
    message = error.message;
  }
  check("throws", message.length > 0);
  check("names the store", message.includes("testshop"), message);
  check("one request only", api.received.length === 1);
  await api.close();
}

console.log("\n6. GraphQL errors surface without the query document");
{
  const api = await fakeShopify([{ body: { errors: [{ message: "Field 'nope' doesn't exist on type 'Shop'" }] } }]);
  let message = "";
  try {
    await makeClient(api.endpoint).request("query GetShopInfo { shop { nope } }");
  } catch (error) {
    message = error.message;
  }
  check("reports the API message", message.includes("doesn't exist"), message);
  check("omits the GraphQL document", !message.includes("GetShopInfo"), message);
  check("stays short", message.length < 200, `${message.length} chars`);
  await api.close();
}

console.log("\n7. ACCESS_DENIED names the missing scope");
{
  const denial = { body: { errors: [{ message: "Access denied for products field.", extensions: { code: "ACCESS_DENIED" } }] } };

  const api = await fakeShopify([denial]);
  let message = "";
  try {
    await makeClient(api.endpoint, { scopes: { granted: () => ["read_orders"] } }).request(
      "query { products(first: 1) { edges { node { id } } } }",
    );
  } catch (error) {
    message = error.message;
  }
  check("names the denied field", message.includes("products"), message);
  check("infers the required scope", message.includes("read_products"), message);
  check("reports what is currently granted", message.includes("read_orders"), message);
  await api.close();

  // The case from the field report: app installed with no scopes at all.
  const api2 = await fakeShopify([denial]);
  let message2 = "";
  try {
    await makeClient(api2.endpoint, { scopes: { granted: () => [] } }).request(
      "query { products(first: 1) { edges { node { id } } } }",
    );
  } catch (error) {
    message2 = error.message;
  }
  check("calls out a token with zero scopes", /no Admin API access scopes at all/.test(message2), message2);
  check("tells the user to reinstall", /reinstall/i.test(message2), message2);
  check("does not retry a permission failure", api2.received.length === 1);
  await api2.close();
}

console.log("\n8. A hung upstream times out instead of hanging the tool call");
{
  const api = await fakeShopify([{ hang: true }]);
  const started = Date.now();
  let message = "";
  try {
    await makeClient(api.endpoint, { timeoutMs: 300, maxAttempts: 1 }).request("query { shop { name } }");
  } catch (error) {
    message = error.message;
  }
  const elapsed = Date.now() - started;
  check("gives up promptly", elapsed < 5000, `took ${elapsed}ms`);
  check("reports a timeout or unreachable host", /within 0.3s|Could not reach/.test(message), message);
  await api.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
