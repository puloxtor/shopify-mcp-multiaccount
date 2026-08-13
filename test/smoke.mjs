#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the built server over real MCP stdio
 * JSON-RPC. Covers what actually broke in production use — tool descriptions
 * reaching the client, multi-store registration, per-call `store` targeting
 * without disturbing the shared active store, and the server surviving a
 * store it cannot reach. Uses fake static tokens throughout, so it needs no
 * real Shopify credentials and hits no real network beyond localhost.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function startServer(env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  return {
    child,
    async initialize() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async listTools() {
      const res = await send("tools/list", {});
      return res.result.tools;
    },
    async callTool(name, args = {}) {
      const res = await send("tools/call", { name, arguments: args });
      const text = res.result?.content?.[0]?.text ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* error results are plain prose */
      }
      return { text, parsed, isError: Boolean(res.result?.isError) };
    },
    stop() {
      child.kill();
    },
  };
}

function exitCodeOf(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const stderr = [];
    child.stderr.on("data", (c) => stderr.push(c.toString()));
    child.on("exit", (code) => resolve({ code, stderr: stderr.join("") }));
    child.stdin.end();
  });
}

const multiStoreEnv = {
  SHOPIFY_STORES: JSON.stringify([
    { name: "alpha", domain: "alpha-smoke.myshopify.com", accessToken: "shpat_fake_alpha" },
    { name: "beta", domain: "beta-smoke.myshopify.com", accessToken: "shpat_fake_beta", default: true },
  ]),
};

console.log("\n1. Multi-store server: registration and metadata");
{
  const server = startServer(multiStoreEnv);
  await server.initialize();
  const tools = await server.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  check("server exposes tools", tools.length >= 44, `got ${tools.length}`);
  check(
    "every tool has a description",
    tools.every((t) => t.description?.length > 0),
    `${tools.filter((t) => !t.description).length} missing`,
  );
  check("list-shops is registered", byName.has("list-shops"));
  check("switch-shop is registered", byName.has("switch-shop"));
  check("read tools are marked read-only", byName.get("get-products")?.annotations?.readOnlyHint === true);
  check("destructive tools are marked destructive", byName.get("order-cancel")?.annotations?.destructiveHint === true);
  check(
    "store arg is offered on store-scoped tools when multi-store",
    Boolean(byName.get("get-products")?.inputSchema?.properties?.store),
  );
  check(
    "store arg is absent from server-scoped tools",
    !byName.get("list-shops")?.inputSchema?.properties?.store &&
      !byName.get("switch-shop")?.inputSchema?.properties?.store,
  );

  console.log("\n2. list-shops reports both stores and their scope state");
  const listed = await server.callTool("list-shops");
  check("list-shops succeeds", !listed.isError, listed.text.slice(0, 160));
  check("both stores are listed", listed.parsed?.shops?.length === 2);
  check("default store is active", listed.parsed?.currentStore === "beta");
  check(
    "static-token stores report unknown (not empty) scopes",
    listed.parsed?.shops?.every((s) => s.accessScopes === null),
  );

  console.log("\n3. Per-call `store` targets a store without switching the shared active one");
  const before = await server.callTool("list-shops");
  const overridden = await server.callTool("get-shop-info", { store: "alpha" });
  const after = await server.callTool("list-shops");
  check("override call fails cleanly (fake domain, no real Shopify)", overridden.isError);
  check("override call names the store it tried", overridden.text.includes("alpha"), overridden.text.slice(0, 160));
  check(
    "active store is unchanged by the override",
    before.parsed?.currentStore === after.parsed?.currentStore && after.parsed?.currentStore === "beta",
  );

  console.log("\n4. switch-shop actually changes the active store");
  const switched = await server.callTool("switch-shop", { name: "alpha" });
  check("switch-shop succeeds", !switched.isError);
  check("reports the new store", switched.parsed?.switchedTo === "alpha");
  const afterSwitch = await server.callTool("list-shops");
  check("active store persists across calls", afterSwitch.parsed?.currentStore === "alpha");

  console.log("\n5. Unreachable store fails cleanly, without killing the server");
  const failed = await server.callTool("get-shop-info");
  check("call reports an error result", failed.isError);
  check("error names the store", failed.text.includes("alpha"), failed.text.slice(0, 160));
  check("error does not dump the GraphQL document", !failed.text.includes("query GetShopInfo"), `${failed.text.length} chars`);
  check("error stays concise", failed.text.length < 400, `${failed.text.length} chars`);
  const stillAlive = await server.callTool("list-shops");
  check("server still serving after a store failure", !stillAlive.isError);

  console.log("\n6. Unknown store name is rejected with the valid names");
  const unknown = await server.callTool("get-products", { store: "does-not-exist" });
  check("unknown store errors", unknown.isError);
  check("error lists configured names", unknown.text.includes("alpha") && unknown.text.includes("beta"), unknown.text.slice(0, 200));

  server.stop();
}

console.log("\n7. Single-store (legacy flags) still works unchanged, with no store noise");
{
  const server = startServer({ MYSHOPIFY_DOMAIN: "solo-smoke.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_fake_solo" });
  await server.initialize();
  const tools = await server.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  check(
    "store arg is omitted entirely with one store configured",
    !byName.get("get-products")?.inputSchema?.properties?.store,
  );
  check(
    "descriptions are present in single-store mode too",
    tools.every((t) => t.description?.length > 0),
  );
  server.stop();
}

console.log("\n8. Configuration errors exit with a usable message, don't hang");
{
  const none = await exitCodeOf({ MYSHOPIFY_DOMAIN: "", SHOPIFY_ACCESS_TOKEN: "", SHOPIFY_CLIENT_ID: "", SHOPIFY_STORES: "" });
  check("no config exits non-zero", none.code === 1, `exit ${none.code}`);

  const badJson = await exitCodeOf({ SHOPIFY_STORES: "{not json" });
  check("invalid SHOPIFY_STORES JSON exits non-zero", badJson.code === 1);
  check("names the problem", /not valid JSON/.test(badJson.stderr), badJson.stderr.slice(0, 200));

  const badShape = await exitCodeOf({ SHOPIFY_STORES: JSON.stringify([{ name: "x" }]) });
  check("store missing credentials exits non-zero", badShape.code === 1);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
