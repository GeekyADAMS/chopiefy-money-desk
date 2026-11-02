# Chopiefy Money Desk

A Chord teammate that records, tracks and settles every invoice in or out of Chopiefy from WhatsApp.
This repo holds the MCP server that gives the teammate its tools. Paystack (test mode) moves the money and a Google Sheet keeps the books.

Status: the MCP endpoint, the Paystack client and the test and quality gates are in place. The tools land after the Paystack probe.

## Layout

```
api/mcp.ts                          MCP endpoint (Streamable HTTP, stateless, bearer auth), a Vercel function
lib/paystack.ts                     Paystack client: test keys only, kobo amounts, typed errors
lib/rules.ts                        business rules: approvals, limits, no double payment, chase spacing, Lagos dates
lib/sheet.ts                        Google Sheets client: service-account sign-in, layout check, RAW writes
lib/ledger.ts                       facts read off the Ledger and Parties, and the WhatsApp messages (no network)
lib/tools.ts                        the MCP tools Chord calls (contracts: ADR 0011)
skill/                              the Chord skill: SKILL.md + references/ (upload this folder to Chord)
test/*.test.ts                      unit and in-process integration tests (no network); tools run against test/fakes.ts
test/live/*.test.ts                 Paystack test-mode and Sheet contract tests (network, needs keys)
scripts/probe-paystack.ts           calls every Paystack endpoint we depend on, saves raw responses
scripts/setup-sheet.ts              lays out the Ledger and Parties tabs, safe to run again
docs/adr/                           architecture decision records, one per major decision
.githooks/pre-push                  runs the secret scan and `pnpm verify` before every push
.github/workflows/verify.yml        same gate in CI
.claude/skills/verify-and-review/   review gate agents run before pushing or opening a PR
```

## Run it

Requires Node 22+ and pnpm (`corepack enable` picks up the pinned version).

```sh
pnpm install                    # also points git at .githooks
cp .env.example .env.local      # fill in MCP_TOKEN, a Paystack sk_test_ key and the Sheet credentials
pnpm verify                     # typecheck + tests, no keys needed
pnpm test:live                  # Paystack test-mode and Sheet contract tests
pnpm setup:sheet                # lay out the Sheet's tabs, then protect the approved column by hand
pnpm probe:paystack             # Paystack test-mode probe, writes probe-output/
pnpm dev                        # local server via the Vercel CLI, endpoint at /api/mcp
```

Try the tools by hand with the MCP Inspector: `pnpm dlx @modelcontextprotocol/inspector`, transport "Streamable HTTP",
URL `http://localhost:3000/api/mcp`, header `Authorization: Bearer <MCP_TOKEN>`.

## How we work

Docs first, then tests, then code. Major decisions get an ADR in `docs/adr/`. Every push passes `pnpm verify`,
and agents also run the `verify-and-review` skill. The full rules are in [CLAUDE.md](CLAUDE.md).

## Deploy

Production is `https://chopiefy-money-desk.vercel.app/api/mcp` (Vercel project `chopiefy-money-desk`, personal
scope). The project is connected to this repo, so every merge to `main` deploys; pull requests get preview builds.
By hand: `vercel deploy --prod`.

Production needs `MCP_TOKEN`, `PAYSTACK_SECRET_KEY` (a test key), `PAYOUT_LIMIT_NGN`, `DAILY_LIMIT_NGN`, `SHEET_ID`
and `GOOGLE_SERVICE_ACCOUNT_B64`, set in Vercel (`vercel env add <name> production`), never in the repo.
`.vercelignore` is an allowlist: only `api/`, `lib/` and the package files are uploaded.

Register the endpoint in Chord as an MCP server with auth type `bearer` and the `MCP_TOKEN` value, and list the
five tools under Allowed tools.
