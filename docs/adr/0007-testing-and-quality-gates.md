# 0007. Testing strategy and quality gates

- Status: Accepted
- Date: 2026-11-01

## Context
This code moves money and agents will push to it. We want fast feedback on every change, proof that integrations
behave as we assume, and a gate that catches mistakes before they reach `main`, without adding a framework to learn.

## Decision
- **Runner:** Node's built-in `node:test` and `node:assert`, run through `tsx --test`. Mocks use `node:test`'s `mock`.
- **Three layers:**
  - Unit tests (`test/*.test.ts`) for pure logic and clients with `fetch` mocked: the rules, the Paystack client
    and mapping Sheet rows.
  - In-process integration tests (`test/*.test.ts`) that drive the real MCP endpoint with the real SDK and
    transport, using only the external APIs mocked. No network, so they run in `pnpm test`.
  - Live contract tests (`test/live/`) against Paystack test mode, skipped without an `sk_test_` key and run with
    `pnpm test:live`. They are read-only; moving money stays in `scripts/probe-paystack.ts`.
- Tests live in `test/`, never next to the code in `api/`, because Vercel would deploy every file in `api/` as a
  function.
- **Gates:**
  - `pnpm verify`, which runs the typecheck and the tests, is the definition of green.
  - The `.githooks/pre-push` hook runs `verify` and a secret scan. It is installed by `pnpm install` through
    `prepare`.
  - The GitHub Actions workflow `.github/workflows/verify.yml` runs `verify` on pushes to `main` and on pull requests.
  - The `verify-and-review` skill is the judgment gate that agents run before pushing or opening a PR. It ends in
    PASS or BLOCK.
- **Test-first:** a new behaviour starts as a failing test, and a bug fix starts with a regression test.

## Consequences
- No dependencies beyond `tsx`, which we already use.
- The live tests can't run in CI without a key in CI secrets. They are run locally before money-path changes, and
  the gate says when they were skipped.
- No lint or format tooling: `tsc --strict` plus review covers what matters here. Add Biome if style drift appears
  with more contributors.

## Alternatives considered
- Vitest or Jest: nicer output, but a dependency and config for what `node:test` already does.
- CI-only gating: feedback arrives after the push. The hook catches problems first, and CI catches bypasses.
