// Unit tests for the business rules (ADR 0005, ADR 0006). Pure functions: no network, no clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canChase,
  formatNaira,
  isOverdue,
  lagosDate,
  limitsFromEnv,
  payoutDecision,
  transferReference,
  type PayoutInput,
} from "../lib/rules.js";

const limits = { perPaymentKobo: 100_000_00, dailyKobo: 300_000_00 }; // ₦100,000 and ₦300,000

const payout = (over: Partial<PayoutInput> = {}): PayoutInput => ({
  amountKobo: 50_000_00,
  paidTodayKobo: 0,
  limits,
  status: "open",
  inFlight: false,
  bankDetailsVerified: true,
  approved: false,
  ...over,
});

test("payout: a verified supplier within limits can be paid without approval", () => {
  assert.deepEqual(payoutDecision(payout()), { ok: true });
});

test("payout: never pays an invoice twice", () => {
  const d = payoutDecision(payout({ status: "paid", approved: true }));
  assert.equal(d.ok, false);
  assert.match(d.ok ? "" : d.reason, /already paid/);
});

test("payout: refuses while an earlier attempt's outcome is still unknown or pending", () => {
  const d = payoutDecision(payout({ inFlight: true, approved: true }));
  assert.equal(d.ok, false);
  assert.match(d.ok ? "" : d.reason, /check its status/i);
});

test("payout: rejects zero, negative and fractional kobo", () => {
  for (const amountKobo of [0, -100, 10.5, Number.NaN]) {
    assert.equal(payoutDecision(payout({ amountKobo })).ok, false, `accepted ${amountKobo}`);
  }
});

test("payout: new or changed bank details wait for the owner's approval", () => {
  const d = payoutDecision(payout({ bankDetailsVerified: false }));
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.needsApproval, true);
  assert.match(d.ok ? "" : d.reason, /new bank details/);
  assert.deepEqual(payoutDecision(payout({ bankDetailsVerified: false, approved: true })), { ok: true });
});

test("payout: the per-payment limit is inclusive, and over it needs approval", () => {
  assert.deepEqual(payoutDecision(payout({ amountKobo: limits.perPaymentKobo })), { ok: true });
  const d = payoutDecision(payout({ amountKobo: limits.perPaymentKobo + 1 }));
  assert.equal(!d.ok && d.needsApproval, true);
  assert.match(d.ok ? "" : d.reason, /per-payment limit of ₦100,000/);
  assert.deepEqual(payoutDecision(payout({ amountKobo: limits.perPaymentKobo + 1, approved: true })), { ok: true });
});

test("payout: the daily limit counts what was already paid today", () => {
  assert.deepEqual(payoutDecision(payout({ amountKobo: 50_000_00, paidTodayKobo: 250_000_00 })), { ok: true });
  const d = payoutDecision(payout({ amountKobo: 50_000_00, paidTodayKobo: 250_000_01 }));
  assert.equal(!d.ok && d.needsApproval, true);
  assert.match(d.ok ? "" : d.reason, /daily limit of ₦300,000/);
});

test("payout: every reason for approval is listed, not just the first", () => {
  const d = payoutDecision(payout({ bankDetailsVerified: false, amountKobo: 150_000_00, paidTodayKobo: 200_000_00 }));
  assert.match(d.ok ? "" : d.reason, /new bank details.*per-payment limit.*daily limit/s);
});

const now = new Date("2026-11-04T09:00:00Z"); // 10:00 in Lagos

test("chase: an unpaid invoice never chased can be chased", () => {
  assert.deepEqual(canChase({ status: "open", lastChased: null, now }), { ok: true });
});

test("chase: never chases someone who has paid", () => {
  const d = canChase({ status: "paid", lastChased: null, now });
  assert.equal(d.ok, false);
  assert.match(d.ok ? "" : d.reason, /already paid/);
});

test("chase: at most one reminder per 48 hours, and says when the next is allowed", () => {
  const justUnder = new Date(now.getTime() - 48 * 3_600_000 + 1);
  const d = canChase({ status: "open", lastChased: justUnder, now });
  assert.equal(d.ok, false);
  assert.match(d.ok ? "" : d.reason, /Next reminder from 4 Nov, 10:00/);
  const exactly = new Date(now.getTime() - 48 * 3_600_000);
  assert.deepEqual(canChase({ status: "part", lastChased: exactly, now }), { ok: true });
});

test("transfer reference: deterministic, lowercase, within Paystack's rules", () => {
  assert.equal(transferReference("OUT-0057", 1), "chopiefy-out-0057-1");
  assert.equal(transferReference("OUT-0057", 1), transferReference("OUT-0057", 1));
  assert.notEqual(transferReference("OUT-0057", 2), transferReference("OUT-0057", 1));
  for (const ref of [transferReference("OUT-1", 1), transferReference("OUT-0057", 12)]) {
    assert.match(ref, /^[a-z0-9_-]{16,}$/);
  }
});

test("transfer reference: refuses ids or attempts that could collide or break the format", () => {
  assert.throws(() => transferReference("OUT 0057", 1));
  assert.throws(() => transferReference("IN-0001", 1), /OUT/);
  assert.throws(() => transferReference("OUT-0057", 0));
  assert.throws(() => transferReference("OUT-0057", 1.5));
});

test("dates: the Lagos calendar day, not the UTC one", () => {
  assert.equal(lagosDate(new Date("2026-11-04T22:59:59Z")), "2026-11-04");
  assert.equal(lagosDate(new Date("2026-11-04T23:00:00Z")), "2026-11-05"); // midnight in Lagos
});

test("overdue: only once the due date has passed in Lagos", () => {
  assert.equal(isOverdue("2026-11-04", new Date("2026-11-04T22:59:59Z")), false);
  assert.equal(isOverdue("2026-11-04", new Date("2026-11-04T23:00:00Z")), true);
  assert.throws(() => isOverdue("4/11/2026", now));
});

test("naira formatting for WhatsApp messages", () => {
  assert.equal(formatNaira(6_140_000), "₦61,400");
  assert.equal(formatNaira(1_999), "₦19.99");
  assert.equal(formatNaira(50), "₦0.50");
});

test("limits come from the environment and fail closed when missing or invalid", () => {
  assert.deepEqual(limitsFromEnv({ PAYOUT_LIMIT_NGN: "100000", DAILY_LIMIT_NGN: "300000" }), limits);
  for (const env of [{}, { PAYOUT_LIMIT_NGN: "100000" }, { PAYOUT_LIMIT_NGN: "abc", DAILY_LIMIT_NGN: "300000" },
    { PAYOUT_LIMIT_NGN: "-5", DAILY_LIMIT_NGN: "300000" }, { PAYOUT_LIMIT_NGN: "500000", DAILY_LIMIT_NGN: "300000" }]) {
    assert.throws(() => limitsFromEnv(env), /PAYOUT_LIMIT_NGN/, JSON.stringify(env));
  }
});
