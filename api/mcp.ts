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
    const response = await handle(request);
    status = response.status;
    return response;
  } finally {
    console.log(JSON.stringify({ ...call, status, ms: Date.now() - started, client: short(request.headers.get("user-agent")) }));
  }
}

async function handle(request: Request): Promise<Response> {
  // Serverless instances share no memory, so each request gets a fresh server and a stateless transport.
  const server = new McpServer({ name: "chopiefy-money-desk", version: "0.1.0" });
  registerTools(server);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

// Stateless mode has no sessions or server-initiated streams to open or close.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
export const DELETE = GET;
