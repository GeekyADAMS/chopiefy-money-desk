# 0010. Ledger and Parties layout, and the facts we derive instead of store

- Status: Accepted. How new rows are written is superseded by [0012](0012-rows-written-in-place.md)
- Date: 2026-11-01

## Context
ADR 0004 makes the Sheet the books. The owner reads and edits it by hand, so the layout must be obvious, and every
column we add is one more thing that can drift. The rules in `lib/rules.ts` need to know whether bank details are
new, whether a payment is still in flight and whether a cash payment is verified.

## Decision
`Ledger` tab, one row per invoice, in this column order:

| Column | Meaning |
| --- | --- |
| `id` | `IN-0143` or `OUT-0057`; never reused, never a row number |
| `direction` | `IN` (owed to Chopiefy) or `OUT` (Chopiefy owes) |
| `party` | A name from the Parties tab |
| `description` | What it was for |
| `amount_ngn` | Naira, as a number |
| `due_date` | `YYYY-MM-DD` |
| `status` | `open`, `part`, `paid`, `failed` or `reversed` |
| `paystack_code` | IN: the payment request code (`PRQ_…`). OUT: the latest transfer reference (`chopiefy-out-0057-1`) |
| `recipient_code` | OUT: the Paystack recipient a transfer went to |
| `last_chased` | When the last reminder link was issued (ISO time) |
| `paid_at` | When Paystack says it was paid (ISO time). Only the server writes it |
| `created_at` | When the row was recorded (ISO time) |
| `note` | Free text, for people |
| `approved` | Checkbox, always the last column. Owner only: protected so only the owner's Google account can edit it |

`Parties` tab: `name`, `kind` (`household`, `event` or `supplier`), `phone` (international, for WhatsApp links),
`email` (optional, ADR 0008), `bank_code`, `account_number`, `account_name` (as the bank returned it),
`recipient_code`.

Derived, not stored:
- **Bank details verified** = an earlier OUT row for the same party is `paid` with the same `recipient_code`, a
  transfer reference and a `paid_at`, so cash the owner marked paid by hand doesn't count.
  Changing a supplier's account in Parties gives a new recipient, so the next payout needs approval. A hand
  edit to `account_number` that leaves the old `recipient_code` would pay the old account while the Sheet shows
  the new one, so `pay_supplier` fetches the recipient from Paystack and treats any mismatch with the Parties row
  as changed details.
- **Transfer attempt** = the number at the end of `paystack_code`.
- **Cash, unverified** = `paid` with no `paid_at`: the owner set it by hand and Paystack never saw the money.
- **Overdue** = `open` or `part` with `due_date` before today in Lagos (ADR 0004).

The server never writes `approved`; `lib/sheet.ts` refuses to. It is the last column because once the owner
protects it, Google refuses any write whose range spans it, even one that leaves that cell empty (seen
2026-11-02 when it sat in the middle). Appends write `A:M` and stop before it. A row counts only if it has an
`id` (or, in Parties, a `name`), because empty rows under a checkbox column read as `FALSE`. Owner-entered text columns (`phone`,
`bank_code`, `account_number`) are formatted as plain text so leading zeros survive.

## Consequences
- Every rule input comes from the Sheet or Paystack, so there is no hidden state to fall out of step.
- Protecting the `approved` column is a manual step for the owner; `pnpm setup:sheet` prints how. Until it is done,
  any editor could approve.
- Renaming or moving a column stops the server with a clear error (ADR 0009) until the header row is put back.
- With the protection on, the service account can't delete a Ledger row (a whole row spans the protected column).
  That suits the books: invoices are corrected or marked, never deleted by the server.

## Alternatives considered
- A `verified` checkbox on Parties: one more owner-only column, and it can go stale when details change.
- An `attempt` column: duplicates what the reference already says.
- A separate Approvals tab: easier to protect, but ticking a box on the row is what the owner will actually do.
