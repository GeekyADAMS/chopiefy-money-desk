# 0005. Payouts are idempotent through deterministic transfer references

- Status: Accepted
- Date: 2026-10-31

## Context
A WhatsApp agent will retry. The model may call `pay_supplier` twice, a request can time out after Paystack has
already accepted it, and the owner may say "pay it" again. Paying a supplier twice is the worst failure this
system can have. Paystack rejects a transfer whose reference it has already seen. A reference may contain only
lowercase letters, digits, `-` and `_`, and must be at least 16 characters long.

## Decision
- Every transfer uses the reference `chopiefy-<invoice id, lowercased>-<attempt>`, for example `chopiefy-out-0057-1`, and the
  Ledger row stores it.
- `attempt` goes up only after a verify by reference shows the previous attempt definitely `failed` or `reversed`.
- A timeout or network error means "unknown": verify by reference first, and never send a new transfer blind.
- Before transferring, `pay_supplier` re-reads the row; if it is already paid or has a pending reference, it reports
  that instead.

## Consequences
- A duplicate call with the same attempt number is refused by Paystack itself, not just by our code.
- The Sheet must never lose the stored reference. Losing it is the one way to reach attempt 1 twice, and Paystack
  would still reject that duplicate.
- The probe checks that Paystack really rejects a reused reference in test mode, and the result is a field note.

## Alternatives considered
- Random references with a "paid" check in the Sheet: a race or a stale read pays twice.
- An idempotency table in a database: extra state for something Paystack already guarantees.
