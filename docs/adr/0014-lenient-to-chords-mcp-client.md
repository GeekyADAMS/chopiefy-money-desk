# 0014. Lenient to Chord's MCP client: any Accept header, plain tool schemas

- Status: Accepted
- Date: 2026-11-03

## Context
Two Money Desk turns in Chord (2026-11-03, 15:17 and 16:09 Lagos) ended after one line, before any tool ran.
Chord's health probe of our server says "ok", and the probe lists our tools. So Chord reaches us with the token.
We can't see the teammate's own tool calls from our side. Before blaming Chord, we checked what our server would
refuse that a working probe wouldn't hit:

- The MCP SDK answers **406** to any POST whose `Accept` header doesn't list both `application/json` and
  `text/event-stream`. Chord's docs say its client "sends JSON POST requests and accepts JSON or SSE responses",
  so a runtime client sending only `application/json` would be refused on every call.
- Our advertised tool schemas carried `$schema`, `format: "email"` and `exclusiveMinimum`. Some model providers
  reject function schemas with those keywords (Gemini, for one, accepts only a subset of JSON Schema). Chord
  doesn't say which provider it routes to.

Vercel's live log stream (`vercel logs`) drops lines: a test on 2026-11-03 got 8 of 11 requests. A missing line
proves nothing.

## Decision
- `api/mcp.ts` always passes `Accept: application/json, text/event-stream` to the transport. Replies are JSON
  anyway (`enableJsonResponse`).
- `tools/list` replies drop `$schema` and `format`. The amount is declared `min(0.01)`, which with the two-decimal
  rule is the same as "positive", and shows as `minimum` instead of `exclusiveMinimum`.
- The request log line also records the client's `accept` and `mcp-protocol-version` headers.

## Consequences
- These keywords only guide the model. The server still validates every argument against the full zod schema,
  email format included, so nothing is accepted that wasn't before.
- Being lenient on `Accept` is a small departure from the MCP spec, where clients must list both. It can't hurt
  a client that lists both.
- The next Chord turn's log line shows what Chord's runtime client sends. Read it in the Vercel dashboard
  (Logs, kept for an hour), not only the CLI stream.
