#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the built server over real MCP stdio JSON-RPC.
 *
 * Covers the things that actually broke in production use — tool descriptions
 * reaching the client, multi-store registration, per-call store targeting,
 * required `store` on destructive tools, and the server surviving a store it
 * cannot reach. Deliberately hits no real Shopify API: the fake domains
 * resolve nowhere, which is exactly what exercises the failure paths.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

// ── minimal MCP stdio client ───────────────────────────────────────────

function startServer(args, env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dist/index.js"), ...args], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map();
  const stderr = [];
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
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method}`)),
        60_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  return {
    child,
    stderr,
    send,
    notify: (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    async initialize() {
      const res = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      });
      this.notify("notifications/initialized");
      return res;
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
      return { raw: res, text, parsed, isError: Boolean(res.result?.isError) };
    },
    stop() {
      child.kill();
    },
  };
}

function exitCodeOf(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "dist/index.js"), ...args], {
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

// ── fixtures ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "shopify-mcp-smoke-"));
const storesPath = join(dir, "stores.json");
writeFileSync(
  storesPath,
  JSON.stringify({
    defaultStore: "alpha",
    stores: [
      {
        alias: "alpha",
        label: "Alpha Store",
        domain: "alpha-smoke-test.myshopify.com",
        accessToken: "${ALPHA_TOKEN}",
      },
      {
        alias: "beta",
        label: "Beta Store",
        domain: "beta-smoke-test.myshopify.com",
        clientId: "beta-id",
        clientSecret: "beta-secret",
      },
    ],
  }),
);

// ── tests ──────────────────────────────────────────────────────────────

console.log("\n1. Multi-store server: registration and metadata");
{
  const server = startServer([`--stores=${storesPath}`], { ALPHA_TOKEN: "shpat_smoke" });
  await server.initialize();
  const { result } = await server.send("tools/list", {});
  const tools = result.tools;
  const byName = new Map(tools.map((t) => [t.name, t]));

  check("server exposes tools", tools.length > 40, `got ${tools.length}`);
  check(
    "every tool has a description",
    tools.every((t) => t.description?.length > 0),
    `${tools.filter((t) => !t.description).length} missing`,
  );
  check("list-stores is registered", byName.has("list-stores"));
  check("switch-store is registered", byName.has("switch-store"));
  check(
    "read tools are marked read-only",
    byName.get("get-products")?.annotations?.readOnlyHint === true,
  );
  check(
    "destructive tools are marked destructive",
    byName.get("order-cancel")?.annotations?.destructiveHint === true,
  );
  check(
    "store arg is offered on store-scoped tools",
    Boolean(byName.get("get-products")?.inputSchema?.properties?.store),
  );
  check(
    "store arg is required on destructive tools when multi-store",
    byName.get("order-cancel")?.inputSchema?.required?.includes("store") === true,
  );
  check(
    "store arg is absent from server-scoped tools",
    !byName.get("list-stores")?.inputSchema?.properties?.store,
  );

  console.log("\n2. list-stores reports configuration without any network call");
  const listed = await server.callTool("list-stores");
  check("list-stores succeeds", !listed.isError, listed.text.slice(0, 120));
  check("both stores are listed", listed.parsed?.storeCount === 2);
  check("default store is active", listed.parsed?.activeStore === "alpha");
  check(
    "env interpolation resolved the token",
    listed.parsed?.stores?.[0]?.auth === "access_token",
  );
  check(
    "client-credential store detected",
    listed.parsed?.stores?.[1]?.auth === "client_credentials",
  );

  console.log("\n3. Unreachable store fails cleanly, without killing the server");
  const failed = await server.callTool("get-shop-info");
  check("call reports an error result", failed.isError);
  check("error names the store", failed.text.includes("alpha"), failed.text.slice(0, 160));
  check(
    "error does not dump the GraphQL document",
    !failed.text.includes("query GetShopInfo"),
    `${failed.text.length} chars`,
  );
  check("error stays concise", failed.text.length < 400, `${failed.text.length} chars`);

  const stillAlive = await server.callTool("list-stores");
  check("server still serving after a store failure", !stillAlive.isError);

  console.log("\n4. Unknown store is rejected with the valid aliases");
  const unknown = await server.callTool("get-products", { store: "does-not-exist" });
  check("unknown store errors", unknown.isError);
  check(
    "error lists configured aliases",
    unknown.text.includes("alpha") && unknown.text.includes("beta"),
    unknown.text.slice(0, 160),
  );

  console.log("\n5. Input validation");
  const overLimit = await server.callTool("get-products", { limit: 5000 });
  check("limit above Shopify's cap is rejected", overLimit.isError);

  const badId = await server.callTool("get-customer-by-id", { id: "not-an-id" });
  check("malformed customer id is rejected", badId.isError);

  server.stop();
}

console.log("\n6. Single-store (legacy flags) still works unchanged");
{
  const server = startServer([
    "--domain=solo-smoke-test.myshopify.com",
    "--accessToken=shpat_smoke",
  ]);
  await server.initialize();
  const { result } = await server.send("tools/list", {});
  const byName = new Map(result.tools.map((t) => [t.name, t]));

  const listed = await server.callTool("list-stores");
  check(
    "single store is auto-active",
    listed.parsed?.activeStore === "solo-smoke-test",
    `got ${listed.parsed?.activeStore}`,
  );
  check(
    "alias derived from the domain's subdomain",
    listed.parsed?.stores?.[0]?.alias === "solo-smoke-test",
    `got ${listed.parsed?.stores?.[0]?.alias}`,
  );
  check(
    "store arg is omitted entirely when only one store is configured",
    !byName.get("get-products")?.inputSchema?.properties?.store &&
      !byName.get("order-cancel")?.inputSchema?.properties?.store,
  );
  check(
    "destructive tools stay callable without a store arg",
    !(byName.get("order-cancel")?.inputSchema?.required ?? []).includes("store"),
  );
  check(
    "descriptions are present in single-store mode too",
    result.tools.every((t) => t.description?.length > 0),
  );
  server.stop();
}

console.log("\n7. Configuration errors exit with a usable message");
{
  const none = await exitCodeOf([]);
  check("no config exits non-zero", none.code === 1, `exit ${none.code}`);
  check("no config explains how to configure", none.stderr.includes("--stores="));

  const badDefault = await exitCodeOf([`--stores=${storesPath}`, "--defaultStore=nope"], {
    ALPHA_TOKEN: "shpat_smoke",
  });
  check("unknown defaultStore exits non-zero", badDefault.code === 1);
  check(
    "unknown defaultStore names the valid aliases",
    badDefault.stderr.includes("alpha, beta"),
    badDefault.stderr.slice(0, 200),
  );

  const missingEnv = await exitCodeOf([`--stores=${storesPath}`]);
  check("unset ${VAR} exits non-zero", missingEnv.code === 1);
  check(
    "unset ${VAR} names the variable",
    missingEnv.stderr.includes("ALPHA_TOKEN"),
    missingEnv.stderr.slice(0, 200),
  );
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
