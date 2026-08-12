#!/usr/bin/env node
/**
 * Transport-level tests for ShopifyClient against a local stand-in for the
 * Shopify Admin API.
 *
 * These cover the paths that only appear under load or after a long idle —
 * rate limiting, expired tokens, flaky upstreams — which are exactly the ones
 * that are impossible to reproduce on demand against the real API.
 */

import { createServer } from "node:http";
import { ShopifyClient } from "../dist/lib/shopifyClient.js";

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

/** Start a server that replies according to a queue of scripted responses. */
function fakeShopify(script) {
  const received = [];
  let index = 0;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({
        token: req.headers["x-shopify-access-token"],
        body: JSON.parse(body || "{}"),
      });
      const step = script[Math.min(index++, script.length - 1)];
      if (step.hang) return; // never responds; exercises the timeout
      res.writeHead(step.status ?? 200, {
        "Content-Type": "application/json",
        ...(step.headers ?? {}),
      });
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

/** Token provider that counts issuances so refreshes are observable. */
function countingTokens(kind = "client_credentials") {
  let issued = 0;
  let current = "token-1";
  return {
    kind,
    get issued() {
      return issued;
    },
    async getToken() {
      issued++;
      return current;
    },
    invalidate() {
      current = "token-2";
    },
  };
}

function makeClient(endpoint, tokens, overrides = {}) {
  return new ShopifyClient({
    storeAlias: "testshop",
    domain: "testshop.myshopify.com",
    apiVersion: "2026-01",
    tokens,
    endpoint,
    ...overrides,
  });
}

const OK = { body: { data: { shop: { name: "Test Shop" } } } };

console.log("\n1. Successful request");
{
  const api = await fakeShopify([OK]);
  const data = await makeClient(api.endpoint, countingTokens()).request("query { shop { name } }");
  check("returns the data payload", data?.shop?.name === "Test Shop");
  check("sends the access token", api.received[0].token === "token-1");
  check("sends query and variables", "query" in api.received[0].body && "variables" in api.received[0].body);
  await api.close();
}

console.log("\n2. THROTTLED is retried, then succeeds");
{
  const api = await fakeShopify([
    { body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
    OK,
  ]);
  const data = await makeClient(api.endpoint, countingTokens()).request("query { shop { name } }");
  check("recovers after a throttle", data?.shop?.name === "Test Shop");
  check("retried exactly once", api.received.length === 2, `${api.received.length} requests`);
  await api.close();
}

console.log("\n3. HTTP 429 is retried, honouring Retry-After");
{
  const api = await fakeShopify([
    { status: 429, headers: { "Retry-After": "1" }, body: {} },
    OK,
  ]);
  const started = Date.now();
  const data = await makeClient(api.endpoint, countingTokens()).request("query { shop { name } }");
  const elapsed = Date.now() - started;
  check("recovers after a 429", data?.shop?.name === "Test Shop");
  check("waited for Retry-After", elapsed >= 900, `waited ${elapsed}ms`);
  await api.close();
}

console.log("\n4. HTTP 5xx is retried");
{
  const api = await fakeShopify([{ status: 503, body: {} }, { status: 503, body: {} }, OK]);
  const data = await makeClient(api.endpoint, countingTokens()).request("query { shop { name } }");
  check("recovers after transient 5xx", data?.shop?.name === "Test Shop");
  check("made three attempts", api.received.length === 3, `${api.received.length} requests`);
  await api.close();
}

console.log("\n5. HTTP 401 triggers exactly one token refresh");
{
  const api = await fakeShopify([{ status: 401, body: {} }, OK]);
  const tokens = countingTokens("client_credentials");
  const data = await makeClient(api.endpoint, tokens).request("query { shop { name } }");
  check("recovers after a 401", data?.shop?.name === "Test Shop");
  check("retried with a fresh token", api.received[1].token === "token-2");
  await api.close();
}

console.log("\n6. Repeated 401 gives up with an actionable message");
{
  const api = await fakeShopify([{ status: 401, body: {} }]);
  let message = "";
  try {
    await makeClient(api.endpoint, countingTokens()).request("query { shop { name } }");
  } catch (error) {
    message = error.message;
  }
  check("throws rather than looping", message.length > 0);
  check("names the store", message.includes("testshop"), message);
  check("explains what to check", /client ID\/secret|scopes/i.test(message), message);
  check("does not retry forever", api.received.length === 2, `${api.received.length} requests`);
  await api.close();
}

console.log("\n7. Static tokens are not refreshed on 401");
{
  const api = await fakeShopify([{ status: 401, body: {} }]);
  let message = "";
  try {
    await makeClient(api.endpoint, countingTokens("access_token")).request("query { shop { name } }");
  } catch (error) {
    message = error.message;
  }
  check("fails immediately", api.received.length === 1, `${api.received.length} requests`);
  check("mentions the access token", /access token/i.test(message), message);
  await api.close();
}

console.log("\n8. GraphQL errors surface without the query document");
{
  const api = await fakeShopify([
    { body: { errors: [{ message: "Field 'nope' doesn't exist on type 'Shop'" }] } },
  ]);
  let message = "";
  try {
    await makeClient(api.endpoint, countingTokens()).request(
      "query GetShopInfo { shop { nope } }",
    );
  } catch (error) {
    message = error.message;
  }
  check("reports the API message", message.includes("doesn't exist"), message);
  check("omits the GraphQL document", !message.includes("GetShopInfo"), message);
  check("stays short", message.length < 200, `${message.length} chars`);
  await api.close();
}

console.log("\n9. A hung upstream times out instead of hanging the tool call");
{
  const api = await fakeShopify([{ hang: true }]);
  const started = Date.now();
  let message = "";
  try {
    await makeClient(api.endpoint, countingTokens(), {
      timeoutMs: 300,
      maxAttempts: 1,
    }).request("query { shop { name } }");
  } catch (error) {
    message = error.message;
  }
  const elapsed = Date.now() - started;
  check("gives up promptly", elapsed < 5000, `took ${elapsed}ms`);
  check("reports a timeout", /within 0.3s|Could not reach/.test(message), message);
  await api.close();
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
