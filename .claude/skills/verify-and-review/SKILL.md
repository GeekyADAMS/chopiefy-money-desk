---
name: verify-and-review
description: Verification and review gate for the Chopiefy Money Desk repo. Use before every git push, before opening or updating a pull request, before saying work is done, and whenever asked to verify, review or sign off a change. Ends in PASS or BLOCK; never push on BLOCK.
---

# Verify and review gate

The pre-push hook runs the mechanical checks. This skill adds what a hook can't do: read the change and judge it
like a senior reviewer who has to put their name on a payments system. Run every step. Report evidence, not belief.

## 1. Scope the change

- Base = `origin/main` if it exists, else `main`. On a branch with no base yet, review the whole working tree.
- `git status`, `git log --oneline <base>..HEAD`, `git diff <base>...HEAD --stat`, plus uncommitted changes.
- Read every changed file in full, not just the hunks. Open the callers of any function whose behaviour changed.
- Write one sentence each: what changed, and what Chopiefy (the business) gets from it.

## 2. Mechanical checks (all must pass)

Run them yourself and quote the tail of the real output. Never report a result you didn't run.

1. `pnpm verify`: typecheck plus unit and in-process integration tests.
2. `pnpm test:live` if `.env.local` has an `sk_test_` key and the change touches `lib/paystack.ts` or any tool that
   moves money. With no key, say "live tests skipped: no key". That is not a pass.
3. Secrets: `git diff <base>...HEAD | grep -nE 'sk_(test|live)_[0-9A-Za-z]{8,}'` must find nothing, and no `.env*` file
   other than `.env.example` may be tracked (`git ls-files | grep -E '^\.env'`).
4. Any check that can't run (no network, no key) is listed as NOT RUN with the reason.

## 3. Review checklist

A "no" on a **Blocker** line blocks the push. A "no" anywhere else is a finding the author fixes or answers.

**Money (Blocker)**
- The Sheet holds naira and Paystack takes integer kobo. Convert only through `toKobo`/`toNaira`, and sum or compare
  amounts in kobo, never in floating-point naira.
- Every transfer carries a deterministic reference (`chopiefy-<invoice id>-<attempt>`, ADR 0005), and the attempt
  number only goes up after a verify shows the previous attempt failed or reversed.
- A timeout or network error on a money call is treated as "unknown": look it up again, never retry blind, never
  record it as failed.
- Test mode only: the `sk_test_` guard in `lib/paystack.ts` is untouched.

**Business rules (Blocker)**
- Rules are enforced in server code, not only in the skill prompt (ADR 0006): no payout to new or changed bank details,
  or over `PAYOUT_LIMIT_NGN` per payment or `DAILY_LIMIT_NGN` per day, until the owner ticks `approved`; only
  Paystack marks an invoice paid; no invoice paid twice; no chasing someone who has paid; at most one reminder per
  invoice per 48 hours.
- Due dates and "overdue" are calculated in Africa/Lagos time.
- Every money action writes or updates its ledger row, and the tool tells the user what happened in plain words,
  including failure. Nothing is silently dropped.

**Security (Blocker)**
- The MCP endpoint still fails closed without the token. Tool inputs are validated with zod at the boundary.
- No secrets, real customer data or real phone numbers in code, tests, fixtures or docs.

**Tests**
- New behaviour has a test that fails without the change. A bug fix has a regression test.
- Tests check behaviour, not implementation. Only `test/live/` touches the network.
- For non-trivial logic, break it on purpose once and confirm a test goes red.

**Docs**
- A major decision has an ADR: a new dependency, a new external system, an auth change, a data model or Sheet layout
  change, or a change to how money moves. A superseded ADR is marked superseded, not edited away.
- README, `.env.example` and `CLAUDE.md` match reality: new env vars, commands and setup steps are documented.

**Simplicity and performance**
- Could this be smaller? Look for unused code, abstractions with one user, config nobody changes, or a dependency
  where the stdlib or a few lines would do.
- No extra round trips per tool call when one will do. Nothing slow runs at module load, because it delays every
  cold start. Tool calls stay well under the function timeout.
- No unrelated changes mixed in.

## 4. Verdict

Reply in exactly this shape:

```
GATE: PASS | BLOCK
Change: <one sentence>  Business value: <one sentence>
Checks: verify <pass/fail> · live <pass/fail/skipped: reason> · secrets <clean/found>
Blockers:
- <file:line> <what is wrong> → <the fix>
Findings (non-blocking):
- <file:line> <finding>
```

- PASS: push, or open the PR with this verdict in its description.
- BLOCK: don't push. Fix the blockers and run the whole gate again from step 2, or hand back to the user.
- Never use `git push --no-verify`, never weaken a test to make it pass, and never edit an ADR to fit the code
  instead of the other way round.
