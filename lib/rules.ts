// Business rules the server enforces whatever the prompt says (ADR 0005, ADR 0006).
// Pure functions: the tools gather the facts (Sheet row, Paystack status, clock) and pass them in.
import { toKobo } from "./paystack.js";

export const STATUSES = ["open", "part", "paid", "failed", "reversed"] as const;
export type Status = (typeof STATUSES)[number];
export type Decision = { ok: true } | { ok: false; reason: string; needsApproval?: boolean };
export type Limits = { perPaymentKobo: number; dailyKobo: number };

const TZ = "Africa/Lagos";
const CHASE_GAP_MS = 48 * 3_600_000;
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export interface PayoutInput {
  amountKobo: number;
  paidTodayKobo: number; // OUT transfers already sent or pending today (Lagos day)
  limits: Limits;
  status: Status;
  inFlight: boolean; // the row has a reference whose transfer isn't known to have failed or reversed
  bankDetailsVerified: boolean; // false for a new supplier or changed bank details
  approved: boolean; // the owner-only `approved` checkbox
}

export function payoutDecision(p: PayoutInput): Decision {
  if (p.status === "paid") return { ok: false, reason: "This invoice is already paid." };
  if (p.inFlight) {
    return { ok: false, reason: "A payment for this invoice is already pending or unconfirmed. Check its status before paying again." };
  }
  if (!Number.isInteger(p.amountKobo) || p.amountKobo <= 0) return { ok: false, reason: "The amount must be more than ₦0." };

  const needs: string[] = [];
  if (!p.bankDetailsVerified) needs.push("new bank details");
  if (p.amountKobo > p.limits.perPaymentKobo) needs.push(`over the per-payment limit of ${formatNaira(p.limits.perPaymentKobo)}`);
  if (p.paidTodayKobo + p.amountKobo > p.limits.dailyKobo) {
    needs.push(`over the daily limit of ${formatNaira(p.limits.dailyKobo)} (${formatNaira(p.paidTodayKobo)} already paid today)`);
  }
  if (needs.length && !p.approved) {
    return { ok: false, needsApproval: true, reason: `Needs the owner's approval in the Sheet: ${needs.join("; ")}.` };
  }
  return { ok: true };
}

export function canChase(c: { status: Status; lastChased: Date | null; now: Date }): Decision {
  if (c.status === "paid") return { ok: false, reason: "This invoice is already paid, so there's no one to chase." };
  if (c.lastChased && c.now.getTime() - c.lastChased.getTime() < CHASE_GAP_MS) {
    const next = new Date(c.lastChased.getTime() + CHASE_GAP_MS);
    return { ok: false, reason: `Reminded less than 48 hours ago. Next reminder from ${dayTime.format(next)}.` };
  }
  return { ok: true };
}

// Paystack rejects a reused reference, which is what makes a retry unable to pay twice (ADR 0005).
// Its format: lowercase letters, digits, - and _, at least 16 characters.
export function transferReference(invoiceId: string, attempt: number): string {
  if (!/^OUT-\d+$/.test(invoiceId)) throw new Error(`Not an OUT invoice id: ${invoiceId}`);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Bad attempt number: ${attempt}`);
  return `chopiefy-${invoiceId.toLowerCase()}-${attempt}`;
}

export const lagosDate = (d: Date): string => ymd.format(d);

export function isOverdue(dueDate: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error(`Due date must be YYYY-MM-DD: ${dueDate}`);
  return lagosDate(now) > dueDate;
}

export const formatNaira = (kobo: number): string =>
  new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: kobo % 100 ? 2 : 0 }).format(kobo / 100);

export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  const perPayment = Number(env.PAYOUT_LIMIT_NGN);
  const daily = Number(env.DAILY_LIMIT_NGN);
  if (!(perPayment > 0 && daily > 0 && perPayment <= daily)) {
    throw new Error("Set PAYOUT_LIMIT_NGN and DAILY_LIMIT_NGN to positive amounts, with the per-payment limit no higher than the daily one");
  }
  return { perPaymentKobo: toKobo(perPayment), dailyKobo: toKobo(daily) };
}
