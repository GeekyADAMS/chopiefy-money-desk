# 0001. Stateless MCP server in TypeScript on Vercel Functions

- Status: Accepted
- Date: 2026-10-31

## Context
Chord reaches custom tools only as remote MCP servers over public HTTPS (Streamable HTTP); it blocks private and
loopback addresses. The server must be reachable whenever a reviewer messages the teammate, possibly days after
the build. The exercise budget is about 6 hours, so every hour spent on infrastructure comes out of the integration.

## Decision
- TypeScript (strict, ES modules, Node 22+) with the official `@modelcontextprotocol/sdk`, tools registered with
  `McpServer.registerTool` and zod input schemas.
- The SDK's web-standard Streamable HTTP transport in stateless mode (`sessionIdGenerator: undefined`) with JSON
  responses. A new server and transport is built per request. `GET` and `DELETE` return 405, since there is no
  session or server-sent event stream to serve.
- Hosted as a Vercel Function: `api/mcp.ts` exports `POST(request: Request)`.

## Consequences
- No adapter layer: the transport takes a `Request` and returns a `Response`, which is exactly the Vercel handler
  shape. The endpoint is testable in-process with no server running (`test/mcp.test.ts`).
- No memory between calls. Any state lives in the Sheet or Paystack (ADR 0004). This is a constraint we want.
- No server-initiated messages or long streams. None of our tools needs them.
- Added 2026-11-03: each request writes one JSON line to Vercel's logs (method, tool, status, time, client), never
  the arguments, which hold names, amounts and bank details. The first Chord test turn left no trace on our side,
  and without this we couldn't tell whether Chord had called us at all.
- Cold starts add latency to the first call. Keep module-load work light (no client construction or network calls
  at import time).
- Ceiling: the function's time limit. A tool call must finish well inside it, so each tool makes a small, bounded
  number of Paystack and Sheets calls. Measured on the first production deploy (2026-11-02): `cash_position` took
  1.6 s and `check_status` 2.3 s, end to end from the build machine.
- Deploys come from `main` through Vercel's Git integration, so only code that passed the gate ships. The upload
  is an allowlist (`.vercelignore`), so `.env.local` and the probe output can't be sent by a CLI deploy.

## Alternatives considered
- Python with FastMCP: workable, but the TypeScript SDK is the reference implementation, so no gain.
- Express or Vercel's `mcp-handler` package: extra layers over a transport that already speaks `Request`/`Response`.
- Render or Railway free tiers: they sleep, and the first reviewer message would time out. Cloudflare Workers: the
  Google client expects Node APIs. Fly.io: more operations work for no benefit here.
- Chord's "Custom tools (API)", where REST endpoints are declared by hand or imported from OpenAPI (seen 2026-11-01):
  those tool definitions live in the dashboard, outside version control and our tests. With MCP, the tool names,
  schemas and descriptions sit in code next to their handlers and go through the gate.
