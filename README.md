# Chopiefy Money Desk

A Chord teammate that records, tracks and settles every invoice in or out of Chopiefy from WhatsApp.
This repo holds the MCP server that gives the teammate its tools. Paystack (test mode) moves the money and a Google Sheet keeps the books.

Status: the MCP endpoint, the Paystack client and the test and quality gates are in place. The tools land after the Paystack probe.

## Layout

```
api/mcp.ts                          MCP endpoint (Streamable HTTP, stateless, bearer auth), a Vercel function
lib/paystack.ts                     Paystack client: test keys only, kobo amounts, typed errors
skill/                              the Chord skill: SKILL.md + references/ (upload this folder to Chord)
test/*.test.ts                      unit and in-process integration tests (no network)
test/live/*.test.ts                 Paystack test-mode contract tests (network, needs a key)
scripts/probe-paystack.ts           calls every Paystack endpoint we depend on, saves raw responses
docs/adr/                           architecture decision records, one per major decision
.githooks/pre-push                  runs the secret scan and `pnpm verify` before every push
.github/workflows/verify.yml        same gate in CI
.claude/skills/verify-and-review/   review gate agents run before pushing or opening a PR
```

## Run it

Requires Node 22+ and pnpm (`corepack enable` picks up the pinned version).

```sh
pnpm install                    # also points git at .githooks
cp .env.example .env.local      # fill in MCP_TOKEN and a Paystack sk_test_ key
pnpm verify                     # typecheck + tests, no keys needed
pnpm test:live                  # Paystack test-mode contract tests
pnpm probe:paystack             # Paystack test-mode probe, writes probe-output/
pnpm dev                        # local server via the Vercel CLI, endpoint at /api/mcp
```

Try the tools by hand with the MCP Inspector: `pnpm dlx @modelcontextprotocol/inspector`, transport "Streamable HTTP",
URL `http://localhost:3000/api/mcp`, header `Authorization: Bearer <MCP_TOKEN>`.

## How we work

Docs first, then tests, then code. Major decisions get an ADR in `docs/adr/`. Every push passes `pnpm verify`,
and agents also run the `verify-and-review` skill. The full rules are in [CLAUDE.md](CLAUDE.md).

## Deploy

Deploy to Vercel with `MCP_TOKEN` and `PAYSTACK_SECRET_KEY` set as environment variables.
Register `https://<deployment>/api/mcp` in Chord as an MCP server with `auth_type: "bearer"`.
