# Chopiefy Money Desk

A Chord teammate that records, tracks and settles every invoice in or out of Chopiefy from WhatsApp.
This repo holds the MCP server that gives the teammate its tools. Paystack (test mode) moves the money and a Google Sheet keeps the books.

Status: all five tools are live on Vercel and registered in Chord, and the Money Desk teammate runs our skill on Chord.
Chord turns currently stop inside Chord with a billing-settlement error before any tool is called (field notes), so
the end-to-end WhatsApp run waits on a fix from TSG Labs. The owner's go-live note is [docs/go-live.md](docs/go-live.md).

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
scripts/demo-scene.ts               the demo's starting state, made-up people (ADR 0013)
scripts/reset-demo.ts               writes that scene to the live Sheet before each take
scripts/rehearse.ts                 replays scripts/demo-script.txt off Chord with Claude Code headless (fakes, or --live)
scripts/watch.ts                    explains each live call from Chord as it happens; keeps a copy in probe-output/calls.log
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
pnpm rehearse                   # the demo conversation off Chord: no credits, no Paystack (needs the claude CLI)
pnpm rehearse --live            # the same against production: real Sheet, Paystack test mode, you tick and pay
pnpm watch                      # every call to the live server as it happens, in plain English (needs the vercel CLI)
pnpm reset:demo                 # live Sheet back to the demo's start; untick every approval first
```

Try the tools by hand with the MCP Inspector: `pnpm dlx @modelcontextprotocol/inspector`, transport "Streamable HTTP",
URL `http://localhost:3000/api/mcp`, header `Authorization: Bearer <MCP_TOKEN>`.

## How we work

Docs first, then tests, then code. Major decisions get an ADR in `docs/adr/`. Every push passes `pnpm verify`,
and agents also run the `verify-and-review` skill. The full rules are in [CLAUDE.md](CLAUDE.md).

## How AI tools were used

- **Claude Code wrote most of the code, tests, ADRs and docs, working with me.** I chose the business, the scope
  and every trade-off, set up the accounts (Paystack, Google Cloud, Vercel, Chord), locked the Sheet, and reviewed
  and merged every pull request. [CLAUDE.md](CLAUDE.md) holds the rules it worked to.
- **A review gate before every push.** Claude Code agents ran the `verify-and-review` skill: typecheck, tests and a
  fresh review of the diff. The "gate fixes" commits are what those reviews found.
- **Rehearsals without Chord credits.** `pnpm rehearse` runs Claude Code headless as a stand-in teammate, with our
  skill as its only prompt and our five tools as its only tools. It caught wording and script problems before any
  credits were spent.
- **Planning in Claude Docs:** the build plan, decision log, field notes and the owner's operating manual.
- The teammate itself is built and run on Chord, as the brief requires. No AI tool can approve a payment: new bank
  details, or anything over a limit, waits for the owner's tick, and the server enforces that.

## With more time

- **Tell the teammate when the owner ticks.** Today staff message it again after the tick. A Sheets trigger or a
  Chord schedule could do that instead.
- **A Paystack webhook,** so a payment lands in the Sheet the moment it's made, not when someone asks.
- **Pass the staff member's ID into tool calls** (TSG says Chord can add it), so the Ledger records who asked.
- **A morning brief** from a Chord schedule: yesterday's payments, today's overdue and the approvals waiting.
- **A Chord escalation rule** for "the supplier changed their bank details". Today the tool refuses and the skill
  tells staff to stop and phone.
- **A lock** around new invoice IDs and the daily-limit check. Two requests at the same instant could clash.
- **Invoices from photos,** once the simulator accepts images.
- **A household-facing teammate** on its own endpoint, with only "what do I owe" and the pay link.

## Deploy

Production is `https://chopiefy-money-desk.vercel.app/api/mcp` (Vercel project `chopiefy-money-desk`, personal
scope). The project is connected to this repo, so every merge to `main` deploys; pull requests get preview builds.
By hand: `vercel deploy --prod`.

Production needs `MCP_TOKEN`, `PAYSTACK_SECRET_KEY` (a test key), `PAYOUT_LIMIT_NGN`, `DAILY_LIMIT_NGN`, `SHEET_ID`
and `GOOGLE_SERVICE_ACCOUNT_B64`, set in Vercel (`vercel env add <name> production`), never in the repo.
`.vercelignore` is an allowlist: only `api/`, `lib/` and the package files are uploaded.

Register the endpoint in Chord as an MCP server with auth type `bearer` and the `MCP_TOKEN` value, and list the
five tools under Allowed tools.
