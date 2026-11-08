// The Money Desk tools Chord calls (contracts: ADR 0011). Rules come from lib/rules.ts, facts from lib/ledger.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDays, bankDetailsVerified, daysBetween, findInvoice, findParty, invoiceMessage, kobo, naira, nextId, payLink, payoutFacts, reminderMessage,
  statusOf, sumNaira, unsettled, whatsappLink, whatsappNumber, type Invoice, type Party,
} from "./ledger.js";
import { paystack, PaystackError, toKobo } from "./paystack.js";
import { canChase, formatNaira, isOverdue, lagosDate, limitsFromEnv, payoutDecision, transferReference } from "./rules.js";
import { addRow, readRows, SheetError, updateCells, type Cell } from "./sheet.js";

type Json = Record<string, any>;
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const reply = (data: Json): Result => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const refuse = (reason: string) => reply({ refused: reason });
const fail = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

// Outages and bugs become a plain sentence the agent can pass on; refusals never get here.
function describe(err: unknown): string {
  if (err instanceof PaystackError) return `Paystack said no: ${err.message}`;
  if (err instanceof SheetError) return `The Google Sheet failed: ${err.message}`;
  if (err instanceof Error && err.name === "TimeoutError") return "Paystack or the Sheet took too long to answer. Nothing was confirmed; check again in a minute.";
  if (err instanceof TypeError && /fetch failed/.test(err.message)) return "Couldn't reach Paystack or the Sheet. Nothing was confirmed; check again in a minute.";
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}
const safely = <A>(fn: (args: A) => Promise<Result>) => async (args: A) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(describe(err));
  }
};

const read = () => Promise.all([readRows("Ledger"), readRows("Parties")]);

async function markPaid(row: Invoice, paidAt: string) {
  await updateCells("Ledger", row.row, { status: "paid", paid_at: paidAt });
  Object.assign(row, { status: "paid", paid_at: paidAt });
}

// Asks Paystack about an IN invoice and records a payment. Returns undefined when Paystack can't say.
async function refreshIn(row: Invoice): Promise<boolean | undefined> {
  if (!row.paystack_code) return undefined;
  let request: { paid: boolean; paid_at: string | null };
  try {
    request = await paystack("GET", `/paymentrequest/${row.paystack_code}`);
  } catch {
    return undefined;
  }
  if (request.paid && statusOf(row) !== "paid") await markPaid(row, request.paid_at ?? new Date().toISOString());
  return request.paid;
}

type Bank = { name: string; code: string; currency?: string };
let banks: Bank[] | undefined; // cached per warm instance; the list rarely changes
// Paystack also lists dollar accounts (a second "Zenith Bank", seen live); suppliers are paid in naira.
const bankList = async () =>
  (banks ??= (await paystack<Bank[]>("GET", "/bank?country=nigeria&perPage=100")).filter((b) => (b.currency ?? "NGN") === "NGN"));
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
// What people type on WhatsApp, mapped to a piece of Paystack's bank name.
const ALIASES: Record<string, string> = {
  gtb: "guarantytrust", gtbank: "guarantytrust", uba: "unitedbankforafrica", fbn: "firstbankofnigeria", firstbank: "firstbankofnigeria",
};

async function findBank(input: string): Promise<Bank | string> {
  const banks = await bankList();
  const want = ALIASES[squash(input)] ?? squash(input);
  const exact = banks.filter((b) => b.code === input.trim() || squash(b.name) === want);
  const matches = exact.length ? exact : banks.filter((b) => squash(b.name).includes(want));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return `I couldn't find a bank called "${input}". Ask for the bank's full name.`;
  return `"${input}" could be ${matches.map((b) => b.name).join(", ")}. Which one?`;
}
const bankName = async (code: Cell) => (await bankList()).find((b) => b.code === String(code))?.name ?? `bank ${code}`;
const masked = (bank: string, account: Cell) => `${bank} ••••${String(account).slice(-4)}`;

const amount = z.number().min(0.01).max(1_000_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "At most 2 decimal places");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(s)), "Not a real date");
const invoiceId = z.string().regex(/^(IN|OUT)-\d+$/i, "Like IN-0143 or OUT-0057").transform((s) => s.toUpperCase());

type RecordArgs = {
  direction: "IN" | "OUT"; party: string; amount_ngn: number; description: string; due_date: string;
  kind?: "household" | "event"; phone?: string; email?: string; bank?: string; account_number?: string;
};

async function recordInvoice(a: RecordArgs): Promise<Result> {
  const [ledger, parties] = await read();
  const now = new Date();
  const party = findParty(parties, a.party);
  const name = party ? String(party.name) : a.party.trim();

  const twin = ledger.find((r) => statusOf(r) === "open" && r.direction === a.direction && r.party === name &&
    Number(r.amount_ngn) === a.amount_ngn && r.due_date === a.due_date && r.description === a.description);
  if (twin && a.direction === "IN") {
    const phone = party?.phone ?? a.phone ?? "";
    // No request code means Paystack failed on the first attempt: finish that invoice instead of adding another.
    if (!twin.paystack_code) return linkInvoice(twin, name, phone, String(party?.email ?? ""), now);
    return reply({ id: twin.id, already_recorded: true, ...customerLinks(name, phone, twin, now) });
  }
  if (twin) return reply({ id: twin.id, already_recorded: true, ...(party?.kind === "supplier" && await supplierDetails(ledger, party)) });

  return a.direction === "IN" ? recordCustomerInvoice(a, ledger, party, name, now) : recordSupplierInvoice(a, ledger, party, name, now);
}

type Bill = Pick<Invoice, "id" | "row" | "description" | "amount_ngn" | "due_date">;

function customerLinks(name: string, phone: Cell, row: Omit<Bill, "id" | "row"> & Pick<Invoice, "paystack_code">, now: Date) {
  const link = payLink(String(row.paystack_code));
  const message = invoiceMessage(name, row, link, now);
  const number = whatsappNumber(phone);
  return { pay_link: link, message, whatsapp_link: number ? whatsappLink(number, message) : undefined };
}

// The Ledger row comes first (ADR 0011): a Sheet failure bills nobody, and a Paystack failure leaves a row the
// next attempt finishes.
async function recordCustomerInvoice(a: RecordArgs, ledger: Invoice[], party: Party | undefined, name: string, now: Date): Promise<Result> {
  if (party?.kind === "supplier") return refuse(`${name} is a supplier. Money Chopiefy is owed should be billed to a household or event client.`);
  if (!party && !a.kind) return refuse(`${name} is new. Is this a household or an event client?`);
  const phone = party ? party.phone : a.phone;
  if (!phone) return refuse(`${name} has no WhatsApp number on file. I need it to send the invoice.`);
  if (!whatsappNumber(phone)) return refuse(`"${phone}" doesn't look like a WhatsApp number. Ask for it again, like 0803 123 4567.`);

  const email = String(party ? party.email : (a.email ?? ""));
  if (!party) await addRow("Parties", { name, kind: a.kind!, phone: a.phone!, email });
  const bill = { id: nextId(ledger, "IN"), description: a.description, amount_ngn: a.amount_ngn, due_date: a.due_date };
  const row = await addRow("Ledger", { ...bill, direction: "IN", party: name, status: "open", created_at: now.toISOString() });
  return linkInvoice({ ...bill, row }, name, phone, email, now);
}

async function linkInvoice(bill: Bill, name: string, phone: Cell, email: string, now: Date): Promise<Result> {
  let code: string;
  try {
    // Paystack needs an email for every customer; without a real one, a placeholder that never receives mail (ADR 0008).
    // ponytail: example.com is the demo placeholder; production uses a Chopiefy subdomain with no mail server.
    const customer = await paystack<{ customer_code: string }>("POST", "/customer", { email: email || `${squash(name)}@example.com`, first_name: name });
    ({ request_code: code } = await paystack<{ request_code: string }>("POST", "/paymentrequest", {
      customer: customer.customer_code,
      amount: toKobo(Number(bill.amount_ngn)),
      due_date: bill.due_date,
      description: bill.description,
      send_notification: Boolean(email),
    }));
  } catch (err) {
    return fail(`${bill.id} is in the Ledger, but Paystack couldn't create its pay link (${describe(err)}). ` +
      "Record it again with the same details to add the link; it won't be billed twice.");
  }
  try {
    await updateCells("Ledger", bill.row, { paystack_code: code });
  } catch (err) {
    return fail(`Paystack created the pay link ${payLink(code)} for ${bill.id}, but it couldn't be saved in the Sheet (${describe(err)}). ` +
      `Send that link, and ask the owner to put ${code} in ${bill.id}'s paystack_code.`);
  }
  return reply({ id: bill.id, ...customerLinks(name, phone, { ...bill, paystack_code: code }, now), emailed: Boolean(email) });
}

async function recordSupplierInvoice(a: RecordArgs, ledger: Invoice[], party: Party | undefined, name: string, now: Date): Promise<Result> {
  let details: { account: string; account_name: Cell; new_bank_details: boolean };
  let recipientCode: Cell;
  if (party) {
    if (party.kind !== "supplier") return refuse(`${name} is a customer, not a supplier.`);
    const bank = a.bank ? await findBank(a.bank) : undefined;
    if (typeof bank === "string") return refuse(bank);
    if ((a.account_number && a.account_number !== String(party.account_number)) || (bank && bank.code !== String(party.bank_code))) {
      return refuse(`Those bank details are different from the ones on file for ${name}. Changed bank details are how most ` +
        `invoice fraud happens, so I haven't recorded this. The owner should confirm with ${name} by phone and update the Parties tab.`);
    }
    recipientCode = party.recipient_code;
    details = await supplierDetails(ledger, party);
  } else {
    if (!a.bank || !a.account_number) return refuse(`${name} is a new supplier. I need their bank and 10-digit account number.`);
    const bank = await findBank(a.bank);
    if (typeof bank === "string") return refuse(bank);
    let resolved: { account_name: string };
    try {
      resolved = await paystack("GET", `/bank/resolve?account_number=${a.account_number}&bank_code=${bank.code}`);
    } catch (err) {
      if (err instanceof PaystackError && err.httpStatus < 500) {
        return refuse(`${bank.name} couldn't find account ••••${a.account_number.slice(-4)}. Check the number and the bank.`);
      }
      throw err;
    }
    const recipient = await paystack<{ recipient_code: string }>("POST", "/transferrecipient", {
      type: "nuban", name: resolved.account_name, account_number: a.account_number, bank_code: bank.code, currency: "NGN",
    });
    await addRow("Parties", { name, kind: "supplier", bank_code: bank.code, account_number: a.account_number,
      account_name: resolved.account_name, recipient_code: recipient.recipient_code });
    recipientCode = recipient.recipient_code;
    details = { account: masked(bank.name, a.account_number), account_name: resolved.account_name, new_bank_details: true };
  }

  const id = nextId(ledger, "OUT");
  // The account this invoice is for: pay_supplier refuses if Parties points somewhere else by the time it pays.
  await addRow("Ledger", { id, direction: "OUT", party: name, description: a.description, amount_ngn: a.amount_ngn,
    due_date: a.due_date, status: "open", recipient_code: recipientCode, created_at: now.toISOString() });
  return reply({ id, ...details });
}

async function supplierDetails(ledger: Invoice[], party: Party) {
  return { account: masked(await bankName(party.bank_code), party.account_number), account_name: party.account_name,
    new_bank_details: !bankDetailsVerified(ledger, party) };
}

async function cashPosition(): Promise<Result> {
  const [ledger, parties] = await read();
  const now = new Date();
  const today = lagosDate(now);
  const owed = () => ledger.filter((r) => r.direction === "IN" && unsettled(r));

  const checked = owed().filter((r) => r.paystack_code).slice(0, 20);
  const checks = await Promise.all(checked.map(refreshIn));
  const refreshed = checks.every((c) => c !== undefined);
  const justPaid = checked.filter((r) => statusOf(r) === "paid").map((r) => ({ id: r.id, party: r.party, amount: naira(r) }));

  const stillOwed = owed();
  const byDue = (x: Invoice, y: Invoice) => String(x.due_date).localeCompare(String(y.due_date));
  const overdue = stillOwed.filter((r) => isOverdue(String(r.due_date), now)).sort(byDue);
  const notYetDue = stillOwed.filter((r) => !isOverdue(String(r.due_date), now)).sort(byDue);
  const weOwe = ledger.filter((r) => r.direction === "OUT" && unsettled(r));
  const soon = weOwe.filter((r) => String(r.due_date) <= addDays(today, 7));
  const limits = limitsFromEnv(process.env);
  const waiting = weOwe.flatMap((r) => {
    const decision = payoutDecision(payoutFacts(r, ledger, findParty(parties, String(r.party)), limits, now));
    return !decision.ok && decision.needsApproval ? [{ id: r.id, party: r.party, amount: naira(r), reason: decision.reason }] : [];
  });

  return reply({
    refreshed,
    ...(refreshed ? {} : { note: "Paystack couldn't be reached, so these figures are from the Sheet and may miss recent payments." }),
    just_paid: justPaid,
    owed_to_us: {
      total: sumNaira(stillOwed),
      overdue_total: sumNaira(overdue),
      overdue: overdue.map((r) => ({ id: r.id, party: r.party, amount: naira(r), due_date: r.due_date, days_overdue: daysBetween(String(r.due_date), today) })),
      not_yet_due: notYetDue.map((r) => ({ id: r.id, party: r.party, amount: naira(r), due_date: r.due_date })),
    },
    we_owe_next_7_days: { total: sumNaira(soon), items: soon.map((r) => ({ id: r.id, party: r.party, amount: naira(r), due_date: r.due_date })) },
    waiting_for_approval: waiting,
  });
}

async function chaseDebtor({ invoice_ids }: { invoice_ids?: string[] }): Promise<Result> {
  const [ledger, parties] = await read();
  const now = new Date();
  const targets = invoice_ids
    ? invoice_ids.map((id) => findInvoice(ledger, id) ?? id)
    : ledger.filter((r) => r.direction === "IN" && unsettled(r) && isOverdue(String(r.due_date), now));

  const reminded: Json[] = [];
  const alreadyPaid: Json[] = [];
  const skipped: Json[] = [];
  await Promise.all(targets.map(async (row) => {
    if (typeof row === "string") return skipped.push({ id: row, reason: `${row} isn't in the Ledger.` });
    const skip = (reason: string) => skipped.push({ id: row.id, party: row.party, reason });
    if (row.direction !== "IN") return skip("That's money Chopiefy owes, not money owed to us.");
    if (statusOf(row) === "paid") return skip("Already marked paid in the Sheet.");
    if (!row.paystack_code) return skip("It has no Paystack pay link, so there's nothing to send.");

    const paid = await refreshIn(row);
    if (paid === undefined) return skip("Couldn't check Paystack, so I didn't chase: they may have paid.");
    if (paid) return alreadyPaid.push({ id: row.id, party: row.party, amount: naira(row) });

    const decision = canChase({ status: statusOf(row), lastChased: row.last_chased ? new Date(String(row.last_chased)) : null, now });
    if (!decision.ok) return skip(decision.reason);
    const party = findParty(parties, String(row.party));
    const number = whatsappNumber(party?.phone ?? "");
    if (!number) return skip(`${row.party} has no WhatsApp number on file.`);

    const message = reminderMessage(String(row.party), row, payLink(String(row.paystack_code)), now);
    await updateCells("Ledger", row.row, { last_chased: now.toISOString() });
    // Paystack's reminder email doesn't arrive in test mode (ADR 0008), so it's sent but never reported.
    if (party?.email) await paystack("POST", `/paymentrequest/notify/${row.paystack_code}`).catch(() => undefined);
    const late = daysBetween(String(row.due_date), lagosDate(now));
    reminded.push({ id: row.id, party: row.party, amount: naira(row), ...(late > 0 && { days_overdue: late }), message, whatsapp_link: whatsappLink(number, message) });
  }));

  // Keep the Ledger's order, whatever order the Paystack checks finished in.
  const order = (list: Json[]) => list.sort((x, y) => targets.findIndex((t) => (typeof t === "string" ? t : t.id) === x.id) - targets.findIndex((t) => (typeof t === "string" ? t : t.id) === y.id));
  return reply({ reminded: order(reminded), already_paid: order(alreadyPaid), skipped: order(skipped) });
}

async function checkStatus({ invoice_id }: { invoice_id: string }): Promise<Result> {
  const [ledger] = await read();
  const row = findInvoice(ledger, invoice_id);
  if (!row) return refuse(`${invoice_id} isn't in the Ledger.`);
  const id = row.id;

  if (row.direction === "IN") {
    if (row.paystack_code) {
      const paid = await refreshIn(row);
      if (paid === undefined) return fail("Couldn't reach Paystack to check. Try again in a minute.");
      if (paid) return reply({ id, status: "paid", detail: `Paystack shows ${naira(row)} paid on ${row.paid_at}.` });
    }
    if (statusOf(row) === "paid" && !row.paid_at) {
      return reply({ id, status: "paid", detail: "Marked paid by hand in the Sheet (cash). Paystack has no record of it, so it's unverified." });
    }
    return reply({ id, status: row.status, detail: row.paystack_code ? "Paystack shows it unpaid." : "It has no Paystack pay link." });
  }

  if (!row.paystack_code) return reply({ id, status: row.status, detail: "No payment has been sent for it yet." });
  const reference = String(row.paystack_code);
  const transfer = await verifyTransfer(reference);
  if (!transfer) return reply({ id, status: row.status, detail: `Paystack has no transfer with reference ${reference}, so no money went out.` });
  return reply({ id, ...(await settleTransfer(row, reference, transfer)) });
}

// Supplier transfers (ADR 0005).

type Transfer = { status: string; amount?: number; updatedAt?: string };
const TRANSFER_PENDING = new Set(["pending", "otp", "received", "processing", "queued"]);
const paystackCode = (err: unknown) => (err instanceof PaystackError ? (err.body as { code?: string } | null)?.code : undefined);

// Paystack's view of a transfer by our reference; undefined when Paystack never saw it.
async function verifyTransfer(reference: string): Promise<Transfer | undefined> {
  try {
    return await paystack<Transfer>("GET", `/transfer/verify/${reference}`);
  } catch (err) {
    if (err instanceof PaystackError && err.httpStatus === 404) return undefined;
    throw err;
  }
}

// What Paystack says about an OUT row's transfer, written to the row. status is paid, failed or reversed (written),
// pending, or "check" when a person has to look. Nothing here pays.
async function settleTransfer(row: Invoice, reference: string, transfer: Transfer): Promise<{ status: string; detail: string }> {
  const id = String(row.id);
  // A hand-edited reference or amount must never mark the wrong invoice paid, or record an amount Paystack didn't send.
  if (!reference.startsWith(`chopiefy-${id.toLowerCase()}-`) || (transfer.status === "success" && transfer.amount !== kobo(row))) {
    return { status: "check", detail: `Paystack's transfer ${reference} (${formatNaira(transfer.amount ?? 0)}, ${transfer.status}) doesn't match ` +
      `${id} (${naira(row)}). I haven't changed the Sheet. The owner should check ${id}'s amount and paystack_code.` };
  }
  let status: string;
  let detail: string;
  if (transfer.status === "success") {
    status = "paid";
    detail = `Paystack shows the transfer of ${naira(row)} succeeded (reference ${reference}).`;
  } else if (transfer.status === "failed" || transfer.status === "reversed") {
    status = transfer.status;
    detail = `Paystack shows the transfer ${status}. It can be paid again.`;
  } else if (transfer.status === "otp") {
    return { status: "pending", detail: "Paystack is holding the transfer until the account owner enters the OTP it sent them. Don't pay again." };
  } else if (TRANSFER_PENDING.has(transfer.status)) {
    return { status: "pending", detail: `Paystack shows the transfer still ${transfer.status}. Don't pay again; check later.` };
  } else {
    // ponytail: statuses like abandoned, rejected or blocked stop here until a person looks. Treat them as ended once
    // Paystack documents whether money left the balance.
    const next = transferReference(id, Number(reference.match(/-(\d+)$/)?.[1] ?? 0) + 1);
    return { status: "check", detail: `Paystack shows the transfer as "${transfer.status}", which I can't read as paid or failed, ` +
      `so I won't pay again. The owner should check ${reference} in the Paystack dashboard. If no money left, the owner can put ` +
      `${next} in ${id}'s paystack_code to allow a new payment.` };
  }
  try {
    if (status === "paid") {
      if (statusOf(row) !== "paid") await markPaid(row, transfer.updatedAt ?? new Date().toISOString());
    } else if (row.status !== status) {
      await updateCells("Ledger", row.row, { status });
      row.status = status;
    }
  } catch (err) {
    detail += ` The Sheet couldn't record this (${err instanceof Error ? err.message : String(err)}), so run check_status on ${id} later to save it.`;
  }
  return { status, detail };
}

async function paySupplier({ invoice_id }: { invoice_id: string }): Promise<Result> {
  const [ledger, parties] = await read();
  const row = findInvoice(ledger, invoice_id);
  if (!row) return refuse(`${invoice_id} isn't in the Ledger.`);
  if (row.direction !== "OUT") return refuse(`${row.id} is money owed to Chopiefy, not a supplier invoice.`);
  const id = String(row.id);

  // A stored reference first: Paystack may have the transfer even if the Sheet doesn't know how it ended.
  let attempt = 1;
  if (row.paystack_code && statusOf(row) !== "paid") {
    const reference = String(row.paystack_code);
    const stored = Number(reference.match(/-(\d+)$/)?.[1] ?? 0);
    const transfer = await verifyTransfer(reference);
    if (!transfer) attempt = stored || 1; // Paystack never saw it: the same reference is safe to send
    else {
      const settled = await settleTransfer(row, reference, transfer);
      if (settled.status !== "failed" && settled.status !== "reversed") return reply({ id, reference, ...settled });
      attempt = stored + 1;
    }
  }

  // ponytail: two different invoices paid at the same moment can both pass the daily limit (ADR 0011). Fine for
  // one business; a lock around the check and the transfer would be the upgrade.
  // The verify above settled whether a stored reference is in flight, so inFlight is false here.
  const party = findParty(parties, String(row.party));
  const decision = payoutDecision({ ...payoutFacts(row, ledger, party, limitsFromEnv(process.env), new Date()), inFlight: false });
  if (!decision.ok) return refuse(decision.reason);

  if (!party?.recipient_code) return refuse(`${row.party} has no bank details on file. Record their invoice with their bank and account number first.`);
  const changed = "Changed bank details are how most invoice fraud happens, so I haven't paid.";
  // The owner's tick was given for the account the invoice was recorded (or last sent) to.
  if (row.recipient_code && row.recipient_code !== party.recipient_code) {
    return refuse(`${party.name}'s bank details changed since ${id} was recorded. ${changed} The owner should confirm the new ` +
      `account with the supplier by phone, then clear recipient_code on ${id} in the Ledger.`);
  }
  const recipient = await paystack<{ details: { bank_code: string; account_number: string } }>("GET", `/transferrecipient/${party.recipient_code}`);
  if (recipient.details.bank_code !== String(party.bank_code) || recipient.details.account_number !== String(party.account_number)) {
    return refuse(`The bank details for ${party.name} in the Sheet don't match the account Paystack would pay. ${changed} The owner ` +
      "should confirm the account with the supplier by phone, then clear recipient_code in the Parties tab and record the details again.");
  }

  const reference = transferReference(id, attempt);
  const receipt = { id, amount: naira(row), to: `${masked(await bankName(party.bank_code), party.account_number)} (${party.account_name})`, reference };
  // The reference goes in the Ledger before the money moves, so a lost reply can always be looked up.
  await updateCells("Ledger", row.row, { status: "open", paystack_code: reference, recipient_code: party.recipient_code });
  Object.assign(row, { status: "open", paystack_code: reference, recipient_code: party.recipient_code });
  const unknown = (why: string) => fail(`Paystack didn't confirm the payment for ${id} (${why}). It may or may not have gone. ` +
    `Run check_status on ${id} before anything else, and don't pay again until it shows the transfer failed.`);

  let transfer: Transfer | undefined;
  try {
    transfer = await paystack<Transfer>("POST", "/transfer", {
      source: "balance", amount: kobo(row), recipient: party.recipient_code, reference, reason: `${id} ${row.description}`, currency: "NGN",
    });
  } catch (err) {
    if (paystackCode(err) === "duplicate_transfer_reference") {
      // Another call sent this reference first: report that transfer.
      transfer = await verifyTransfer(reference).catch(() => undefined);
      if (!transfer) return unknown("it says this reference was used, but the transfer couldn't be looked up");
    } else if (err instanceof PaystackError && err.httpStatus < 500) {
      // A 4xx is a refusal: Paystack sent nothing. The reference stays, and the next attempt reuses it.
      const why = paystackCode(err) === "insufficient_balance"
        ? "The Paystack balance is too low for this payment; the owner needs to top up the balance first."
        : `Paystack refused the payment: ${err.message.replace(/\.?$/, ".")}`;
      return refuse(`${why} Nothing was sent for ${id}.`);
    } else {
      return unknown(describe(err));
    }
  }
  return reply({ ...receipt, ...(await settleTransfer(row, reference, transfer)) });
}

export function registerTools(server: McpServer) {
  server.registerTool("record_invoice", {
    description: "Record an invoice in the Ledger. IN = someone owes Chopiefy: creates a Paystack pay link and returns a WhatsApp " +
      "message and one-tap link for staff to send. OUT = Chopiefy owes a supplier: a new supplier's account is checked with " +
      "their bank and the account holder's name is returned. Read the details back and get a yes before calling.",
    inputSchema: {
      direction: z.enum(["IN", "OUT"]),
      party: z.string().trim().min(1).max(80).describe("Customer or supplier name as in the Parties tab"),
      amount_ngn: amount.describe("Naira"),
      description: z.string().trim().min(1).max(120).describe("What it's for, e.g. Weekly shopping"),
      due_date: ymd.describe("YYYY-MM-DD, from the payment terms if not given"),
      kind: z.enum(["household", "event"]).optional().describe("New IN customers only"),
      phone: z.string().max(20).optional().describe("New IN customers: WhatsApp number"),
      email: z.email().optional().describe("New IN customers, optional"),
      bank: z.string().max(60).optional().describe("New suppliers: bank name or code"),
      account_number: z.string().regex(/^\d{10}$/).optional().describe("New suppliers: 10-digit account number"),
    },
  }, safely(recordInvoice));

  server.registerTool("cash_position", {
    description: "Who owes Chopiefy (and what's overdue), what Chopiefy owes in the next 7 days, and payouts waiting for the owner's approval. Checks Paystack for new payments first.",
    inputSchema: {},
  }, safely(cashPosition));

  server.registerTool("chase_debtor", {
    description: "Prepare payment reminders. Checks Paystack first so payers are never chased, and allows one reminder per invoice per 48 hours. " +
      "Returns a WhatsApp message and one-tap link per debtor. Confirm the list with staff before calling.",
    inputSchema: { invoice_ids: z.array(invoiceId).max(50).optional().describe("Default: every overdue invoice") },
  }, safely(chaseDebtor));

  server.registerTool("check_status", {
    description: "Ask Paystack whether an invoice was paid or a supplier transfer went through, and record the answer. Use it before anything else when a payment's outcome is unclear.",
    inputSchema: { invoice_id: invoiceId },
  }, safely(checkStatus));

  server.registerTool("pay_supplier", {
    description: "Pay a supplier invoice (OUT) from the Paystack balance. Before calling, confirm the supplier, amount, invoice ID and " +
      "masked account with staff and get a yes. New bank details or amounts over the limits need the owner's tick in the Sheet; the " +
      "tool refuses until then. It never pays an invoice twice. If the outcome is unknown, run check_status before anything else.",
    inputSchema: { invoice_id: invoiceId.describe("Like OUT-0057") },
  }, safely(paySupplier));
}
