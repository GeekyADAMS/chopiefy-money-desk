# 0011. Tool contracts: inputs, the order of writes, and what a half-finished call leaves behind

- Status: Accepted
- Date: 2026-11-02

## Context
The skill (`skill/SKILL.md`) promises five tools. Each one talks to two systems that can fail independently, the
Sheet and Paystack, inside a serverless function that can time out. The model will retry, and it fills in tool
arguments from chat. So for every tool we decide up front what it checks, which system it writes first, and what a
retry finds if the first attempt stopped halfway.

## Decision
All tools validate inputs with zod, read the Ledger and Parties fresh, and return JSON text. A business refusal is
a normal result with `refused: "<reason>"` for the agent to pass on. An outage or bug is an MCP error
(`isError: true`) with a plain message.

**`record_invoice`** `{direction, party, amount_ngn, description, due_date, kind?, phone?, email?, bank?, account_number?}`
- A new IN party needs `kind` and `phone`; a new OUT party needs `bank` and `account_number`. `bank` is a name
  ("GTBank") or a code, matched against Paystack's bank list.
- OUT details that differ from the Parties row are refused as changed bank details (ADR 0010). The owner changes
  them by editing the Parties row and clearing `recipient_code`.
- New supplier: resolve the account name, create the Paystack recipient, add the Parties row, and return the
  account name so staff can check it against the invoice. `new_bank_details` in the reply uses the same rule as
  `pay_supplier`: true until a payout to those details has succeeded.
- IN: write the Ledger row first, then create the Paystack customer (email or an `example.com` placeholder,
  ADR 0008) and the payment request, then save the request code on the row. Returns the ID, the pay link
  `https://paystack.shop/pay/<code>`, the WhatsApp message and its `wa.me` link, and whether Paystack emailed it.
- A retry is caught: an open row with the same direction, party, amount, due date and description is returned as
  "already recorded" rather than added again. If that row has no request code yet (Paystack failed last time),
  the retry creates the pay link for it. So a Sheet failure bills nobody, and a Paystack failure leaves a row the
  retry completes.
- IDs are the highest existing number plus one. Two calls in the same second could pick the same ID; at
  one business's volume that is accepted and noted in code.

**`cash_position`** `{}`
- Refreshes open IN rows from Paystack (in parallel, at most 20), writes any that are now paid, and returns: the ones
  it just found paid (`just_paid`, added 2026-11-03, so staff hear about a payment without asking for it), owed to
  us (total and overdue, overdue listed oldest first), what we owe in the next 7 days, and OUT rows waiting for the
  owner's approval (from `payoutDecision`). If Paystack can't be reached, it says the figures weren't refreshed.

**`chase_debtor`** `{invoice_ids?}` (default: every overdue IN row)
- Per invoice: refresh from Paystack (paid → write it and skip), apply `canChase`, then write `last_chased` and
  return the reminder message and `wa.me` link. Parties with a real email also get Paystack's `notify`, but the
  result never claims an email went out (ADR 0008).

**`pay_supplier`** `{invoice_id}`
- A stored reference is verified first: `success` → mark paid and stop; `pending`/`otp`/`received` → in flight,
  stop; `failed`/`reversed` → the next attempt number; "not found" → Paystack never saw it, so the same reference is
  reused (Paystack would refuse a real duplicate anyway).
- The Parties recipient is fetched from Paystack and must match the row's bank code and account number. If the
  row's `recipient_code` (written by `record_invoice`, then by each attempt) differs from the party's, the details
  changed after the invoice was recorded and perhaps ticked, so it is refused until the owner confirms by phone and
  clears the row's `recipient_code`.
- `payoutDecision` gets: today's total (paid today in Lagos plus every open OUT row with a reference, which
  over-counts on purpose), bank details verified (an earlier paid OUT row to the same recipient), and the owner's
  tick.
- The reference and recipient are written to the Ledger **before** the transfer call. A timeout after that is
  "unknown": the reply tells the agent to run `check_status`, and the next `pay_supplier` verifies the stored
  reference first. Paystack errors `insufficient_balance`, `transfer_unavailable` and
  `duplicate_transfer_reference` become plain sentences; the last one is followed by a verify.
- Any other 4xx from `POST /transfer` means Paystack refused it and nothing was sent; it comes back as a refusal.
  The reference stays on the row, so the next attempt finds "not found" and reuses it. A 5xx, a timeout or a network
  error is "unknown", as above.
- Two calls for the same invoice at once both write the same reference; Paystack accepts one and refuses the other
  as a duplicate, which then verifies and reports the first. Two different invoices at once can both pass the daily
  limit check; at one business's volume that is accepted and noted in code.
- A transfer only settles a row if its reference is that invoice's (`chopiefy-<id>-…`) and, on success, its amount
  matches `amount_ngn`. Otherwise the reply is status `check`: nothing is written or paid, and the owner looks.
  This also applies to `check_status`.
- If the money went but the Sheet can't record it, the reply still says paid, adds that the Sheet missed it, and
  the stored reference lets the next call record it.
- `otp` means Paystack is waiting for the account owner's OTP, so OTP must be off on the Paystack account the
  server uses. Statuses we can't read as paid or failed (`abandoned`, `rejected`, `blocked`) stop as `check` until
  Paystack documents whether money left the balance; its docs pages refused us (HTTP 403) on 2026-11-02. The
  reply names the way out: once the dashboard shows no money left, the owner types the next attempt's reference
  into `paystack_code`, which Paystack has never seen, so the next `pay_supplier` sends it.
- Replies show the account masked (`GTBank ••••4821`).

**`check_status`** `{invoice_id}`
- IN: fetch the payment request. OUT: verify the transfer reference. Write `paid` (with `paid_at`), `failed` or
  `reversed` to the Ledger, and return what Paystack says. A row marked `paid` with no `paid_at` is reported as cash
  entered by hand, unverified.

## Consequences
- Every partial failure leaves either nothing, or a row a retry can recognise. No call leaves money moved with no
  record of it.
- `test/tools.test.ts` runs every tool through the real MCP endpoint against an in-memory Sheet and Paystack,
  including the half-finished cases. The fake Sheet rejects writes to the protected `approved` column, as the real
  one does.
- Split across two PRs: the four tools that don't move money, then `pay_supplier` on its own.
- The owner's tick approves the row as it reads when `pay_supplier` runs. If someone with edit access changes
  `amount_ngn` after the tick, the new amount is paid. Before go-live, staff get view-only access to the Sheet, or
  the owner protects Ledger A:M and the Parties tab so only the owner and the service account can edit them (the
  service account must stay an editor there, or every new row is refused). The same goes for `recipient_code` and
  `paystack_code`: the checks above stop honest mistakes, not someone with edit access who means harm.

## Alternatives considered
- Creating the payment request before writing the Ledger (this ADR's first draft): when the Sheet then failed, as
  it did in the live run on 2026-11-02, a retry found no row and billed the customer a second time.
- A queue or database for in-flight payouts: the stored reference plus Paystack's duplicate check already makes a
  payout safe to retry (ADR 0005).
