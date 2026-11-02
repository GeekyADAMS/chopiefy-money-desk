// Facts read off the Ledger and Parties tabs (ADR 0010), and the messages customers get. Pure: no network.
import { toKobo } from "./paystack.js";
import { formatNaira, lagosDate, type PayoutInput, type Status } from "./rules.js";
import type { Cell, Row } from "./sheet.js";

export type Invoice = Row<"Ledger">;
export type Party = Row<"Parties">;

const same = (a: Cell, b: Cell) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export const statusOf = (r: Invoice) => String(r.status) as Status;
type Bill = Pick<Invoice, "description" | "amount_ngn" | "due_date">;
export const kobo = (r: Pick<Invoice, "amount_ngn">) => toKobo(Number(r.amount_ngn));
export const naira = (r: Pick<Invoice, "amount_ngn">) => formatNaira(kobo(r));
export const sumNaira = (rows: Invoice[]) => formatNaira(rows.reduce((n, r) => n + kobo(r), 0));
export const findParty = (parties: Party[], name: string) => parties.find((p) => same(p.name, name));
export const findInvoice = (ledger: Invoice[], id: string) => ledger.find((r) => r.id === id);
export const payLink = (requestCode: string) => `https://paystack.shop/pay/${requestCode}`;
export const unsettled = (r: Invoice) => statusOf(r) !== "paid";

// ponytail: highest number + 1, so two calls in the same instant could pick the same ID (ADR 0011). Fine for one
// business; a counter cell with a lock would be the upgrade.
export function nextId(ledger: Invoice[], direction: "IN" | "OUT"): string {
  const numbers = ledger.map((r) => String(r.id).match(new RegExp(`^${direction}-(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  return `${direction}-${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}`;
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}
export const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// The facts payoutDecision needs, from the Sheet alone. pay_supplier also checks Paystack before trusting them.
export function payoutFacts(row: Invoice, ledger: Invoice[], party: Party | undefined, limits: PayoutInput["limits"], now: Date): PayoutInput {
  const today = lagosDate(now);
  const paidTodayKobo = ledger
    .filter((r) => r.direction === "OUT" && r.id !== row.id)
    // Sent today, or sent at some point and not yet settled: over-counts on purpose (ADR 0011).
    .filter((r) => (statusOf(r) === "paid" && r.paid_at && lagosDate(new Date(String(r.paid_at))) === today) || (statusOf(r) === "open" && r.paystack_code))
    .reduce((n, r) => n + kobo(r), 0);
  const recipient = party?.recipient_code;
  return {
    amountKobo: kobo(row),
    paidTodayKobo,
    limits,
    status: statusOf(row),
    inFlight: statusOf(row) === "open" && Boolean(row.paystack_code),
    bankDetailsVerified: Boolean(recipient) && ledger.some((r) => r.direction === "OUT" && statusOf(r) === "paid" && r.party === party!.name && r.recipient_code === recipient),
    approved: row.approved === true,
  };
}

// WhatsApp click-to-chat wants the number in international form, digits only. Local 080… numbers become 23480….
export function whatsappNumber(phone: Cell): string | undefined {
  let digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = `234${digits.slice(1)}`;
  return /^\d{10,15}$/.test(digits) ? digits : undefined;
}
export const whatsappLink = (number: string, message: string) => `https://wa.me/${number}?text=${encodeURIComponent(message)}`;

const longDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const lagosHour = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" });
const greeting = (now: Date) => {
  const hour = Number(lagosHour.format(now));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
};
const due = (ymd: string) => longDate.format(new Date(`${ymd}T00:00:00Z`));

export function invoiceMessage(name: string, row: Bill, link: string, now: Date): string {
  return `${greeting(now)} ${name}, here's your Chopiefy invoice for ${row.description}: ${naira(row)}, due ${due(String(row.due_date))}. ` +
    `You can pay securely here: ${link}. Thank you!`;
}

export function reminderMessage(name: string, row: Invoice, link: string, now: Date): string {
  const late = daysBetween(String(row.due_date), lagosDate(now));
  const when = late > 0 ? `is now ${late} day${late === 1 ? "" : "s"} overdue` : `is due ${due(String(row.due_date))}`;
  const opener = row.last_chased ? "a quick reminder that" : "just a gentle reminder that";
  return `${greeting(now)} ${name}, ${opener} your Chopiefy invoice for ${row.description} (${naira(row)}) ${when}. ` +
    `You can pay here: ${link}. Thank you!`;
}
