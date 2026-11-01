# 0003. Plain `fetch` Paystack client, test keys only

- Status: Accepted
- Date: 2026-10-31

## Context
We use a handful of Paystack endpoints: balance, banks, account resolve, transfer recipients, transfers, customers
and payment requests. Paystack's docs site blocks automated reading, so the source of truth for request shapes is
the [PaystackOSS OpenAPI spec](https://github.com/PaystackOSS/openapi). The exercise rules forbid live keys.

## Decision
`lib/paystack.ts` is one function, `paystack<T>(method, path, body?)`, over `fetch`:
- It refuses any key that doesn't start with `sk_test_`, before making any network call.
- It unwraps Paystack's `{ status, message, data }` envelope. `status !== true` or a non-2xx response throws
  `PaystackError` carrying the HTTP status and raw body, even when the HTTP status is 200.
- 15 second timeout. A timeout throws `TimeoutError`, deliberately not a `PaystackError`: the outcome is unknown,
  so callers must look the operation up again (ADR 0005).
- Amounts cross the boundary as integer kobo through `toKobo`/`toNaira`.

## Consequences
- No dependency to keep up to date. Response types are declared where they are used.
- Going live means deliberately removing the test-key guard; it can't happen by setting a variable.
- Paystack behaviour the spec doesn't cover (test-mode transfers, OTP, payment link format) is checked by
  `scripts/probe-paystack.ts`, and the findings are recorded as field notes.

## Alternatives considered
- Community Paystack SDKs: they lag the API, add types we would still have to check, and hide the HTTP status we
  need to tell "refused" from "unknown".
