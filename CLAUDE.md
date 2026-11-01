# Chopiefy Money Desk

MCP server behind a Chord WhatsApp teammate that records, chases and settles Chopiefy's invoices. Paystack (test
mode) moves the money and a Google Sheet keeps the books. Read `README.md` for setup and `docs/adr/` for why things
are the way they are.

## Commands

- `pnpm verify`: typecheck plus unit and in-process integration tests. This is the definition of green.
- `pnpm test:live`: Paystack test-mode contract tests (needs `sk_test_` in `.env.local`).
- `pnpm probe:paystack`: exercises every Paystack call we depend on and writes `probe-output/`.

## How we work

1. **Docs first.** Before code, write down the change: an ADR for any major decision (see `docs/adr/README.md` for
   when), or the README for setup and behaviour. Code that contradicts an accepted ADR is a bug in the code, or it
   needs a superseding ADR.
2. **Test first.** Start a new behaviour with a failing test and a bug fix with a regression test. Pure logic gets
   unit tests; the endpoint gets in-process integration tests; Paystack gets live contract tests. Layout and rules are
   in ADR 0007.
3. **Simple beats impressive.** Use the fewest files, no dependencies the stdlib covers, and no abstraction with one
   user. Mark a deliberate shortcut with a `ponytail:` comment naming its ceiling and the upgrade path.
4. **Correct for the business, not just the compiler.** Every money change is checked against the rules in ADR 0005
   and ADR 0006.
5. **Gate before pushing.** Run the `verify-and-review` skill and push only on PASS. The pre-push hook and CI back it
   up. Never use `--no-verify`.

## Rules that don't bend

- Paystack test keys only. Use made-up people, numbers and accounts. Secrets go only in `.env.local` or Vercel env.
- Money is naira in the Sheet and integer kobo at Paystack, converted only with `toKobo`/`toNaira`.
- A timeout on a money call means "unknown": verify by reference, never retry blind.
- Business rules live in server code (`lib/rules.ts`), not only in the skill prompt.
- Never put tests or helpers in `api/`, because Vercel deploys every file there as a function.
