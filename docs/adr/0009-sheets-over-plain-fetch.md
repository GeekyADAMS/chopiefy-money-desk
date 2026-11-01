# 0009. Google Sheets over plain fetch, with a self-signed service-account token

- Status: Accepted
- Date: 2026-11-01

## Context
ADR 0004 planned `@googleapis/sheets`. We need four calls: read a tab, append a row, update cells, and (for setup)
`batchUpdate`. The SDK brings `google-auth-library`, `gaxios` and their dependencies into every cold start of a
Vercel function. A service account signs in by sending Google a JWT signed with its private key, which Node's
`crypto` does in a few lines. On 2026-11-01 that sign-in read our Sheet on the first try.

Two risks come with a Sheet anyone with access can edit: a moved or renamed column would make us write money
data into the wrong place, and text that starts with `=` would run as a formula.

## Decision
- `lib/sheet.ts` signs an RS256 JWT with `node:crypto`, swaps it for an access token, and caches the token in the
  warm instance until a minute before it expires. Calls go through plain `fetch` with a 15-second timeout, like
  the Paystack client (ADR 0003).
- The key lives in one env var, `GOOGLE_SERVICE_ACCOUNT_B64` (the JSON key file, base64), so the private key's
  newlines survive Vercel's env editor. `SHEET_ID` names the Sheet.
- Every read checks the header row against the layout in ADR 0010 and refuses to go on if it differs.
- Every write uses `valueInputOption=RAW`: text is stored as text, so `=…` from a WhatsApp message is never a
  formula, and account numbers keep their leading zeros.
- Unset values are sent as `null`, which Sheets skips, so a write never touches a cell it wasn't asked to.

## Consequences
- No new dependency; the client is small enough to read in one sitting.
- We own the token code. It is tested against a key pair generated in the test, including caching and refresh.
- Ceiling: if we need more Google APIs (Drive, Gmail), switch to `google-auth-library` for auth and keep the rest.

## Alternatives considered
- `@googleapis/sheets`: the safe default, but heavy for four calls and slower to cold start.
- A Google Apps Script web app in front of the Sheet: no key to manage, but a second deployment with its own auth,
  logs and quotas.
