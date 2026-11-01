// Integration tests for the MCP endpoint, run in-process: real SDK, real transport, no network.
import assert from "node:assert/strict";
import { after, test } from "node:test";
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
