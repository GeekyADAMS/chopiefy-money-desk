# 0013. One demo scene, reset on the live Sheet and rehearsed off Chord

- Status: Accepted
- Date: 2026-11-03

## Context
We have 50 Chord credits for every integration run, the recording and the reviewers' live demo. Each take of the
recording needs the Sheet in the same starting state. Paystack test mode allows only 3 account-name lookups a day
against real banks ("Test mode daily limit of 3 live bank resolves exceeded", 2026-11-03). Those lookups return
real people's names for real account numbers. Its test bank `001` resolves without limit, but Paystack won't
create a transfer recipient for it ("Cannot resolve account", `invalid_bank_code`). The only account we know
pays out and is named "Test" is Zenith (057) 0000000000.

## Decision
- `scripts/demo-scene.ts` holds the one starting state (made-up people, dates relative to today). Both of these
  use it.
- `pnpm reset:demo` writes it to the live Sheet:
  - It refuses while any tick is set in the owner's column, because a reset moves rows and a tick must never land
    on a different invoice.
  - IDs continue above the highest one already in the Ledger, because Paystack remembers every transfer
    reference (`chopiefy-<id>-<n>`) forever. An old reference on a new row would show as `check`.
  - Open IN rows get fresh payment requests (`send_notification: false`).
  - One overdue IN row reuses a payment request paid with a test card on 2026-11-01. The reset checks that it's
    still paid and has the same amount, so `cash_position` always has a payment to report.
  - Mama Nkechi starts in Parties with her existing Paystack recipient, so a take uses no account lookups. With no
    payout to her yet, her bank details count as new and need the owner's tick.
- `pnpm rehearse` runs the demo conversation with no credits or Paystack calls:
  - It serves the real endpoint on localhost, with the same scene loaded into the test fakes (`test/fakes.ts`).
  - Claude Code runs headless, with the skill as its only system prompt and our five tools as its only tools.
  - It replays `scripts/demo-script.txt` turn by turn, ticking and paying where the script says, and prints each
    message, tool call and reply.
- Added 2026-11-04: `pnpm rehearse --live` sends the same conversation to the production endpoint, so the real
  Sheet and Paystack test mode do the work and only Chord is swapped out. A person does each tick and card payment
  when the script pauses for it. It's the fallback recording if Chord's billing-settlement failure isn't fixed in
  time (field notes, 2026-11-03 onwards), and it's run after `pnpm reset:demo`. `pnpm watch` names its client "the
  rehearsal", so a viewer never mistakes it for Chord.

## Consequences
- Wording, tool choice, arguments and refusals are fixed before any credit is spent. The rehearsal can't show how
  Chord loads the skill, which model it runs, how it formats WhatsApp, or what it tells the agent about today's
  date. The harness adds the Lagos date and time itself; whether Chord does is checked on the first real run.
- The owner unticks before each reset. That's one click, and it's the same rule `addRow` now enforces (ADR 0012).
- The reused paid request is tied to our Paystack test account. On another account the reset says so and stops.

## Alternatives considered
- Introducing Mama Nkechi fresh in every take, which shows a live account-name lookup: each take would use one
  or two of the 3 daily lookups, and running out mid-recording ends the take.
- Wiping the Sheet and restarting IDs at 0001: references from earlier takes would collide.
- Rehearsing in Chord: every rehearsal turn spends credits.
