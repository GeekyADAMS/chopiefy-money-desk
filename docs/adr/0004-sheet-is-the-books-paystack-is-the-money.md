# 0004. The Sheet is the books, Paystack is the money, no database

- Status: Accepted. The client library choice is superseded by [0009](0009-sheets-over-plain-fetch.md)
- Date: 2026-10-31

## Context
Chopiefy keeps its books on paper today. The owner needs records they can read, correct and share without us, and
the payment provider already knows whether money actually moved. A third store would have to be kept in step with
both.

## Decision
- A Google Sheet, accessed with `@googleapis/sheets` and a service account it is shared with, is the system of record
  for invoices: a `Ledger` tab (one row per invoice in or out, stable IDs like `IN-0143` and `OUT-0057`, never row
  numbers) and a `Parties` tab (households and suppliers with their payment details).
- Paystack is the truth for whether money moved. Tools refresh a row from Paystack before acting on it or reporting
  it, and write the result back to the Sheet.
- There is no database. The Sheet stores naira; kobo exists only at the Paystack edge. "Overdue" is calculated
  rather than stored, using Africa/Lagos time.

## Consequences
- The owner can audit and fix everything in a tool they already know. Nothing to back up or migrate.
- People can edit the Sheet by hand, so the server re-reads a row immediately before any money action and
  validates what it reads, as untrusted input.
- Ceiling: the Sheets API rate limit (about 60 requests per minute per user) and no transactions. That is fine for one
  business's volume. Move to Postgres when concurrent writers or volume make conflicts real.

## Alternatives considered
- Postgres or Supabase: real transactions, but the owner can't see or fix it, and it is one more system to run.
- Airtable: similar to a Sheet, but less familiar to the owner, and its free-tier limits are tighter.
