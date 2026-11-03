// Integration tests for the MCP endpoint, run in-process: real SDK, real transport, no network.
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { GET, POST } from "../api/mcp.js";

const TOKEN = "test-token";
process.env.MCP_TOKEN = TOKEN;
after(() => {
  delete process.env.MCP_TOKEN;
});

const initialize = (authorization?: string) =>
  new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization && { authorization }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });

test("rejects a missing, wrong or wrong-length token", async () => {
  for (const auth of [undefined, "Bearer wrong-token", "Bearer x", `bearer ${TOKEN}`, TOKEN]) {
    assert.equal((await POST(initialize(auth))).status, 401, `accepted ${auth}`);
  }
});

test("fails closed when MCP_TOKEN is not configured", async () => {
  delete process.env.MCP_TOKEN;
  try {
    assert.equal((await POST(initialize("Bearer "))).status, 401);
    assert.equal((await POST(initialize("Bearer undefined"))).status, 401);
  } finally {
    process.env.MCP_TOKEN = TOKEN;
  }
});

test("an authorised client can initialize", async () => {
  const res = await POST(initialize(`Bearer ${TOKEN}`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(body.result?.serverInfo?.name, "chopiefy-money-desk");
});

test("GET is not served (stateless server, no SSE stream)", () => {
  assert.equal(GET().status, 405);
});

test("logs one line per request: method, tool and status as short strings, never arguments or the token", async () => {
  const post = (body: string, authorization = `Bearer ${TOKEN}`) =>
    POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization },
      body,
    }));
  const log = mock.method(console, "log", () => {});
  try {
    await post(JSON.stringify({ method: "tools/call", params: { name: "x", arguments: { account: "0123456789" } } }), "Bearer wrong");
    // An unknown tool keeps this offline: it never reaches the Sheet.
    await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "no_such_tool", arguments: { account: "0123456789" } } }));
    await post(JSON.stringify({ jsonrpc: "2.0", id: 3, method: { arguments: { account: "0123456789" } } }));
    assert.equal((await post("null")).status, 400);
    await post(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "x".repeat(500) }));
  } finally {
    log.mock.restore();
  }
  const lines = log.mock.calls.map((c) => JSON.parse(String(c.arguments[0])));
  assert.deepEqual(lines.map((l) => [l.rpc, l.tool, l.status]),
    [[undefined, undefined, 401], ["tools/call", "no_such_tool", 200], [undefined, undefined, 400], [undefined, undefined, 400], ["x".repeat(60), undefined, 200]]);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp(`0123456789|${TOKEN}|Bearer`));
});
