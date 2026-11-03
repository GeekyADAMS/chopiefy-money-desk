import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "../lib/tools.js";

// Chord registers this server with auth_type "bearer". Fail closed if the token is unset.
function authorized(request: Request): boolean {
  const token = process.env.MCP_TOKEN;
  if (!token) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 60) : undefined);

// One line per request in Vercel's logs, so a failed call from Chord can be traced. Only short strings, and never the
// arguments: they hold names, amounts and bank details. The body is read only once the token checks out.
export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  let call: { rpc?: string; tool?: string } = {};
  let status = 500;
  try {
    if (!authorized(request)) {
      status = 401;
      return Response.json({ error: "unauthorized" }, { status });
    }
    const body = (await request.clone().json().catch(() => null)) as { method?: unknown; params?: { name?: unknown } } | null;
    call = { rpc: short(body?.method), tool: short(body?.params?.name) };
    const response = await handle(request, call.rpc);
    status = response.status;
    return response;
  } finally {
    const h = (name: string) => short(request.headers.get(name));
    console.log(JSON.stringify({ ...call, status, ms: Date.now() - started, client: h("user-agent"), accept: h("accept"), proto: h("mcp-protocol-version") }));
  }
}

// Chord's docs say its client "accepts JSON or SSE responses"; the SDK answers 406 unless both are listed. Replies here
// are always JSON (enableJsonResponse), so whatever the client lists, it gets JSON.
const BOTH = "application/json, text/event-stream";

// Model providers differ in the JSON Schema they take for a tool (Gemini, for one, refuses "$schema" and string
// formats). These keywords only guide the model: the server still checks every argument against the full zod schema.
const UNSUPPORTED = new Set(["$schema", "format"]);
const plain = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, x]) => [k, plain(x)]))
  : v;

async function handle(original: Request, rpc?: string): Promise<Response> {
  const headers = new Headers(original.headers);
  headers.set("accept", BOTH);
  const request = new Request(original, { headers });
  // Serverless instances share no memory, so each request gets a fresh server and a stateless transport.
  const server = new McpServer({ name: "chopiefy-money-desk", version: "0.1.0" });
  registerTools(server);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  if (rpc !== "tools/list" || response.status !== 200) return response;
  const body = (await response.json()) as { result?: { tools?: { inputSchema: unknown }[] } };
  for (const tool of body.result?.tools ?? []) tool.inputSchema = plain(tool.inputSchema);
  return Response.json(body);
}

// Stateless mode has no sessions or server-initiated streams to open or close.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
export const DELETE = GET;
