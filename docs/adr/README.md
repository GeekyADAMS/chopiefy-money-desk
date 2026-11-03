# Architecture decision records

One file per decision that would be expensive to reverse or surprising to a newcomer. Write the ADR before the code
it governs. Never rewrite an accepted ADR to fit the code: change the code, or add a new ADR that supersedes it.

**Write one when a change** adds a dependency or an external system, changes auth, changes the Sheet layout or any
stored data, changes how money moves or is reconciled, or picks between two reasonable designs.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-stateless-mcp-server-on-vercel.md) | Stateless MCP server in TypeScript on Vercel Functions | Accepted |
| [0002](0002-bearer-token-auth.md) | Bearer token between Chord and the server | Accepted |
| [0003](0003-paystack-plain-fetch-client.md) | Plain `fetch` Paystack client, test keys only | Accepted |
| [0004](0004-sheet-is-the-books-paystack-is-the-money.md) | The Sheet is the books, Paystack is the money, no database | Accepted; client library superseded by 0009 |
| [0005](0005-idempotent-payouts.md) | Payouts are idempotent through deterministic transfer references | Accepted |
| [0006](0006-rules-enforced-in-the-server.md) | Business rules are enforced in the server, not the prompt | Accepted |
| [0007](0007-testing-and-quality-gates.md) | Testing strategy and quality gates | Accepted |
| [0008](0008-whatsapp-first-delivery.md) | WhatsApp first: staff send invoices and reminders with one tap; Paystack emails only real addresses | Accepted |
| [0009](0009-sheets-over-plain-fetch.md) | Google Sheets over plain fetch, with a self-signed service-account token | Accepted |
| [0010](0010-ledger-layout.md) | Ledger and Parties layout, and the facts we derive instead of store | Accepted; append part superseded by 0012 |
| [0011](0011-tool-contracts.md) | Tool contracts: inputs, the order of writes, and what a half-finished call leaves behind | Accepted |
| [0012](0012-rows-written-in-place.md) | New rows are written in place below the last ID, not appended | Accepted |
| [0013](0013-demo-reset-and-rehearsal.md) | One demo scene, reset on the live Sheet and rehearsed off Chord | Accepted |

## Template

Copy into `NNNN-short-title.md`. Keep it under a page.

```markdown
# NNNN. Title as a decision

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
The forces at play: the problem, the constraints, what we know and don't.

## Decision
What we will do, in active voice.

## Consequences
What gets easier, what gets harder, what we must now watch. Include the ceiling and the upgrade path.

## Alternatives considered
- Option: why not.
```
