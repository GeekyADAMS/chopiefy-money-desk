// Integration tests for the MCP endpoint, run in-process: real SDK, real transport, no network.
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { GET, plain, POST } from "../api/mcp.js";

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
  // What the client sent, not the Accept the server forces, so Chord's real headers show in the log.
  assert.equal(lines[1].accept, "application/json, text/event-stream");
  assert.equal(lines[1].proto, undefined);
});

const call = (method: string, accept: string | null) =>
  POST(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(accept !== null && { accept }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  }));

test("answers in JSON whatever the client accepts, instead of the SDK's 406", async () => {
  for (const accept of ["application/json", "text/event-stream", "*/*", null]) {
    const res = await call("tools/list", accept);
    assert.equal(res.status, 200, `Accept: ${accept}`);
    assert.ok(Array.isArray(((await res.json()) as { result: { tools: unknown[] } }).result.tools));
  }
});

test("advertises tool schemas without $schema or format, keeping the rules the model needs", async () => {
  const { result } = (await (await call("tools/list", "application/json")).json()) as {
    result: { tools: { name: string; inputSchema: { properties: Record<string, Record<string, unknown>> } }[] };
  };
  const text = JSON.stringify(result.tools);
  for (const word of ['"$schema"', '"format"', '"exclusiveMinimum"']) assert.ok(!text.includes(word), `still has ${word}`);
  const record = result.tools.find((t) => t.name === "record_invoice")!.inputSchema.properties;
  assert.equal(record.amount_ngn.minimum, 0.01);
  assert.ok(record.email.pattern, "email keeps its pattern");
  assert.deepEqual(record.direction.enum, ["IN", "OUT"]);
});

test("cleaning schemas keeps a parameter whose name is a dropped keyword", () => {
  const schema = { $schema: "x", type: "object", properties: { format: { type: "string", format: "email" }, properties: { type: "object", properties: { $schema: { type: "string" } } } }, required: ["format"] };
  assert.deepEqual(plain(schema), { type: "object", properties: { format: { type: "string" }, properties: { type: "object", properties: { $schema: { type: "string" } } } }, required: ["format"] });
});

test("an amount that rounds to 0 kobo is refused before any tool code runs", async () => {
  for (const amount_ngn of [1e-9, 0.005, 0]) {
    const res = await POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_invoice",
        arguments: { direction: "IN", party: "Mrs Test", amount_ngn, description: "Test", due_date: "2026-11-10" } } }),
    }));
    const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    assert.equal(result.isError, true, `accepted ${amount_ngn}`);
    assert.match(result.content[0].text, /amount_ngn/);
  }
});
