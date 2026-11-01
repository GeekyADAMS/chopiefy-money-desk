# 0002. Bearer token between Chord and the server

- Status: Accepted
- Date: 2026-10-31

## Context
The MCP endpoint is public on the internet and its tools move money. Chord supports `none`, `bearer`, `api_key` and
`oauth` auth for custom tools. There is exactly one client: our Chord teammate.

## Decision
Chord sends `Authorization: Bearer <MCP_TOKEN>`. The server compares the whole header against the expected value in
constant time (`timingSafeEqual`, after a length check) and returns 401 before any MCP processing. If `MCP_TOKEN`
is unset, every request is rejected.

## Consequences
- One secret to rotate: set a new `MCP_TOKEN` in Vercel and in Chord's server config together.
- It fails closed, so a deploy missing the variable can't be called rather than being open to everyone.
- The token identifies the teammate, not the person messaging it. Sender identity, if Chord passes it, is a
  separate question tracked in the open questions.

## Alternatives considered
- OAuth: needs dynamic client registration and PKCE for a single machine client. Overkill here.
- No auth with an unguessable URL: the URL leaks into logs and screenshots, and the tools move money.
