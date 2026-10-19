import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryLimiter, setup } from "./helpers.ts";

const EXPECTED_TOOLS = [
  "search_areas",
  "find_variables",
  "get_variable_metadata",
  "list_sections_and_periods",
  "get_section_dimensions",
  "estimate_data_size",
  "preview_data",
  "get_data_page",
  "get_complete_data",
  "get_data_series",
  "quota_status",
  "get_dictionary",
];

test("initialize negotiates protocol version and advertises tools", async () => {
  const { rpc } = setup();
  const known = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(known.status, 200);
  assert.equal(known.body.result.protocolVersion, "2025-03-26");
  assert.ok(known.body.result.capabilities.tools);
  assert.equal(known.body.result.serverInfo.name, "dbw-statistics-poland");

  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.body.result.protocolVersion, "2025-06-18");
});

test("tools/list returns all twelve read-only tools with schemas", async () => {
  const { rpc } = setup();
  const { body } = await rpc("tools/list");
  const names = body.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, EXPECTED_TOOLS);
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(tool.description.length > 20);
  }
});

test("notifications get 202 with no body, ping works, unknown methods error", async () => {
  const { handler, rpc } = setup();
  const res = await handler(new Request("http://x/", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }));
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");

  assert.deepEqual((await rpc("ping")).body.result, {});
  assert.equal((await rpc("does/not/exist")).body.error.code, -32601);
});

test("batches return an array of responses", async () => {
  const { handler } = setup();
  const res = await handler(new Request("http://x/", {
    method: "POST",
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
  }));
  const body = await res.json();
  assert.equal(body.length, 2);
  assert.deepEqual(body.map((r: { id: number }) => r.id), [1, 2]);
});

test("malformed requests return JSON-RPC errors", async () => {
  const { handler } = setup();
  const bad = await handler(new Request("http://x/", { method: "POST", body: "{not json" }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);

  const invalid = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ id: 1, method: "ping" }) }));
  assert.equal((await invalid.json()).error.code, -32600);

  const badVersion = await handler(new Request("http://x/", {
    method: "POST",
    headers: { "MCP-Protocol-Version": "1900-01-01" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }));
  assert.equal(badVersion.status, 400);
});

test("GET is rejected with 405 and CORS preflight succeeds", async () => {
  const { handler } = setup();
  const get = await handler(new Request("http://x/", { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  const options = await handler(new Request("http://x/", { method: "OPTIONS" }));
  assert.equal(options.status, 200);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");
  assert.match(options.headers.get("access-control-allow-headers") ?? "", /Mcp-Protocol-Version/);
});

test("unknown tool is a protocol error; non-object arguments are a tool error", async () => {
  const { rpc } = setup();
  const unknown = await rpc("tools/call", { name: "drop_tables", arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
  const badArgs = await rpc("tools/call", { name: "search_areas", arguments: [1, 2] });
  assert.equal(badArgs.body.result.isError, true);
  assert.equal(badArgs.body.result.structuredContent.error.code, "INVALID_ARGUMENT");
});

test("access token is enforced when configured", async () => {
  const { rpc } = setup({ accessToken: "s3cret-token" });
  const missing = await rpc("ping");
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/);
  const wrong = await rpc("ping", undefined, { Authorization: "Bearer nope" });
  assert.equal(wrong.status, 401);
  const right = await rpc("ping", undefined, { Authorization: "Bearer s3cret-token" });
  assert.equal(right.status, 200);
});

test("inbound rate limit returns 429 with Retry-After per client", async () => {
  const limiter = memoryLimiter();
  const { handler } = setup({ limiter });
  const send = (ip: string) =>
    handler(new Request("http://x/", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
  for (let i = 0; i < 60; i++) assert.equal((await send("1.1.1.1")).status, 200);
  const limited = await send("1.1.1.1");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await limited.json()).error.data.retry_after_seconds, 60);
  assert.equal((await send("2.2.2.2")).status, 200);
});
