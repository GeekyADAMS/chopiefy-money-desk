// The tools, called through the real MCP endpoint against an in-memory Sheet and Paystack (test/fakes.ts).
// Contracts: ADR 0011. The clock is fixed at 10:00 on Thursday 5 November 2026, Lagos time.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { POST } from "../api/mcp.js";
import { COLUMNS } from "../lib/sheet.js";
import { fakeWorld, type FakePaystack, type FakeSheet } from "./fakes.js";

type Json = Record<string, any>;
const TOKEN = "tools-test-token";
const NOW = Date.parse("2026-11-05T09:00:00Z");
let sheet: FakeSheet;
let paystack: FakePaystack;
let rpcId = 0;

beforeEach(() => {
  process.env.MCP_TOKEN = TOKEN;
  mock.timers.enable({ apis: ["Date"], now: NOW });
  ({ sheet, paystack } = fakeWorld());
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

async function call(name: string, args: Json = {}): Promise<{ isError: boolean; data: any }> {
  const res = await POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const json = (await res.json()) as Json;
  if (json.error) return { isError: true, data: json.error.message };
  const text = json.result.content[0].text as string;
  return json.result.isError ? { isError: true, data: text } : { isError: false, data: JSON.parse(text) };
}

const household = { name: "Mrs Adeyemi", kind: "household", phone: "0803 000 0001", email: "" };
const supplier = { name: "Mama Nkechi", kind: "supplier", bank_code: "058", account_number: "0123454821", account_name: "NKECHI OKAFOR FOODS" };
const billAdeyemi = { direction: "IN", party: "Mrs Adeyemi", amount_ngn: 61400, description: "Weekly shopping", due_date: "2026-11-08" };

test("the endpoint lists the tools, each with a description and an input schema", async () => {
  const res = await POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
    }),
  );
  const { tools } = ((await res.json()) as Json).result;
  assert.deepEqual(tools.map((t: Json) => t.name).sort(), ["cash_position", "chase_debtor", "check_status", "pay_supplier", "record_invoice"]);
  for (const t of tools) assert.ok(t.description.length > 40 && t.inputSchema.type === "object", t.name);
});

test("record_invoice: billing a supplier as a customer is refused", async () => {
  sheet.seed("Parties", supplier);
  assert.match((await call("record_invoice", { ...billAdeyemi, party: "Mama Nkechi" })).data.refused, /is a supplier/);
});

// ---------- record_invoice ----------

test("record_invoice IN: bills a known household, numbered after the last invoice, with a one-tap WhatsApp link", async () => {
  sheet.seed("Parties", household);
  sheet.seed("Ledger", { id: "IN-0142", direction: "IN", party: "Mrs Bello", amount_ngn: 1000, due_date: "2026-11-01", status: "paid" });

  const { isError, data } = await call("record_invoice", billAdeyemi);

  assert.equal(isError, false, data);
  assert.equal(data.id, "IN-0143");
  const [code] = Object.keys(paystack.requests);
  assert.equal(data.pay_link, `https://paystack.shop/pay/${code}`);
  assert.equal(paystack.requests[code!]!.amount, 6_140_000, "kobo at Paystack");
  assert.equal(paystack.requests[code!]!.send_notification, false, "no email on file, so Paystack mustn't mail the placeholder");
  assert.match(paystack.customers[0]!.email, /@example\.com$/);
  assert.equal(data.emailed, false);
  assert.match(data.message, /₦61,400/);
  assert.match(data.message, /8 November/);
  assert.ok(data.message.includes(data.pay_link));
  assert.equal(data.whatsapp_link, `https://wa.me/2348030000001?text=${encodeURIComponent(data.message)}`);

  const row = sheet.rows("Ledger").at(-1)!;
  assert.deepEqual(
    [row.id, row.direction, row.party, row.amount_ngn, row.due_date, row.status, row.paystack_code],
    ["IN-0143", "IN", "Mrs Adeyemi", 61400, "2026-11-08", "open", code],
  );
  assert.equal(row.created_at, new Date(NOW).toISOString());
});

test("record_invoice IN: a party with an email gets Paystack's email too", async () => {
  sheet.seed("Parties", { ...household, name: "Eko Events", kind: "event", email: "bookings@ekoevents.example.org" });

  const { data } = await call("record_invoice", { ...billAdeyemi, party: "eko events" });

  assert.equal(data.emailed, true);
  assert.equal(Object.values(paystack.requests)[0]!.send_notification, true);
  assert.equal(paystack.customers[0]!.email, "bookings@ekoevents.example.org");
  assert.equal(sheet.rows("Ledger")[0]!.party, "Eko Events", "matched case-insensitively, stored as written in Parties");
});

test("record_invoice IN: a new household needs a WhatsApp number, then is added to Parties", async () => {
  const refused = await call("record_invoice", { ...billAdeyemi, kind: "household" });
  assert.match(refused.data.refused, /WhatsApp number/);
  assert.equal(sheet.rows("Ledger").length + sheet.rows("Parties").length + paystack.customers.length, 0);

  const { data } = await call("record_invoice", { ...billAdeyemi, kind: "household", phone: "+234 803 000 0001" });

  assert.equal(data.id, "IN-0001");
  assert.deepEqual(sheet.rows("Parties")[0], { ...household, phone: "+234 803 000 0001", bank_code: "", account_number: "", account_name: "", recipient_code: "" });
});

test("record_invoice: a retry of the same invoice returns the first one instead of billing twice", async () => {
  sheet.seed("Parties", household);

  const first = await call("record_invoice", billAdeyemi);
  const again = await call("record_invoice", billAdeyemi);

  assert.equal(again.data.id, first.data.id);
  assert.equal(again.data.already_recorded, true);
  assert.equal(again.data.pay_link, first.data.pay_link);
  assert.equal(Object.keys(paystack.requests).length, 1);
  assert.equal(sheet.rows("Ledger").length, 1);
});

test("record_invoice: if the Sheet fails, nobody is billed", async () => {
  sheet.seed("Parties", household);
  sheet.failWritesAfter = 0;

  const { isError, data } = await call("record_invoice", billAdeyemi);

  assert.equal(isError, true);
  assert.match(data, /Google Sheet/);
  assert.equal(Object.keys(paystack.requests).length, 0);
});

test("record_invoice: if Paystack fails, the invoice is kept and a retry adds its pay link without billing twice", async () => {
  sheet.seed("Parties", household);
  paystack.failures["POST /paymentrequest"] = { status: 500, code: "unknown", message: "Error occurred while creating payment request" };

  const first = await call("record_invoice", billAdeyemi);
  assert.equal(first.isError, true);
  assert.match(first.data, /IN-0001 is in the Ledger/);
  assert.match(first.data, /again/);
  assert.equal(sheet.rows("Ledger")[0]!.paystack_code, "");

  delete paystack.failures["POST /paymentrequest"];
  const retry = await call("record_invoice", billAdeyemi);

  assert.equal(retry.data.id, "IN-0001");
  assert.equal(retry.data.pay_link, "https://paystack.shop/pay/PRQ_1");
  assert.equal(sheet.rows("Ledger").length, 1);
  assert.equal(sheet.rows("Ledger")[0]!.paystack_code, "PRQ_1");
});

test("record_invoice: if saving the pay link fails, the error carries the link so it isn't lost", async () => {
  sheet.seed("Parties", household);
  sheet.failWritesAfter = 1; // the row is written, saving its request code fails

  const { isError, data } = await call("record_invoice", billAdeyemi);

  assert.equal(isError, true);
  assert.match(data, /https:\/\/paystack\.shop\/pay\/PRQ_1/);
});

test("record_invoice OUT: a new supplier's account is resolved, saved and shown back by name", async () => {
  const { data } = await call("record_invoice", {
    direction: "OUT", party: "Mama Nkechi", amount_ngn: 85000, description: "Tomatoes", due_date: "2026-11-06",
    bank: "GTB", account_number: "0123454821",
  });

  assert.equal(data.id, "OUT-0001");
  assert.equal(data.account_name, "NKECHI OKAFOR FOODS");
  assert.equal(data.account, "Guaranty Trust Bank ••••4821");
  assert.equal(data.new_bank_details, true);
  assert.ok(!JSON.stringify(data).includes("0123454821"), "the full account number never goes back to chat");
  assert.deepEqual(sheet.rows("Parties")[0], { ...supplier, phone: "", email: "", recipient_code: "RCP_1" });
  assert.equal(sheet.rows("Ledger")[0]!.recipient_code, "RCP_1", "the account this invoice is for");
});

test("record_invoice OUT: different bank details for a known supplier are refused as possible fraud", async () => {
  sheet.seed("Parties", { ...supplier, recipient_code: "RCP_1" });

  const { data } = await call("record_invoice", {
    direction: "OUT", party: "Mama Nkechi", amount_ngn: 85000, description: "Tomatoes", due_date: "2026-11-06",
    bank: "OPay", account_number: "0987650011",
  });

  assert.match(data.refused, /bank details/);
  assert.match(data.refused, /owner/);

  const sameBank = await call("record_invoice", {
    direction: "OUT", party: "Mama Nkechi", amount_ngn: 85000, description: "Tomatoes", due_date: "2026-11-06",
    bank: "GTBank", account_number: "0123459999",
  });
  assert.match(sameBank.data.refused, /bank details/, "a new account at the same bank is still a change");
  const sameNumber = await call("record_invoice", {
    direction: "OUT", party: "Mama Nkechi", amount_ngn: 85000, description: "Tomatoes", due_date: "2026-11-06",
    bank: "OPay", account_number: "0123454821",
  });
  assert.match(sameNumber.data.refused, /bank details/, "the same number at another bank is a different account");
  assert.equal(sheet.rows("Ledger").length, 0);
  assert.equal(sheet.rows("Parties")[0]!.account_number, "0123454821");
});

test("record_invoice OUT: an unknown or ambiguous bank is refused with the choices", async () => {
  const base = { direction: "OUT", party: "New Supplier", amount_ngn: 1000, description: "x", due_date: "2026-11-06", account_number: "0123454821" };

  assert.match((await call("record_invoice", { ...base, bank: "Moon Bank" })).data.refused, /couldn't find/i);
  const zenith = await call("record_invoice", { ...base, party: "Zenith Supplier", bank: "Zenith", account_number: "0000000000" });
  assert.equal(zenith.data.account_name, "Test", "Paystack's USD Zenith entry doesn't make it ambiguous");
  const ambiguous = (await call("record_invoice", { ...base, bank: "Access" })).data.refused;
  assert.match(ambiguous, /Access Bank \(Diamond\)/);
  assert.equal(sheet.rows("Parties").length, 1, "only the Zenith supplier");
});

test("record_invoice OUT: a known supplier's details count as new until a payout to them has succeeded", async () => {
  scene();
  const bill = { direction: "OUT", amount_ngn: 1000, description: "x", due_date: "2026-11-06" };

  assert.equal((await call("record_invoice", { ...bill, party: "Mama Nkechi" })).data.new_bank_details, false, "OUT-0050 was paid to her");
  assert.equal((await call("record_invoice", { ...bill, party: "Gas Man" })).data.new_bank_details, true, "never paid, as pay_supplier sees it");
});

test("record_invoice rejects bad input before touching anything", async () => {
  for (const bad of [{ amount_ngn: -5 }, { amount_ngn: 10.001 }, { due_date: "8/11/2026" }, { direction: "SIDEWAYS" }]) {
    assert.equal((await call("record_invoice", { ...billAdeyemi, ...bad })).isError, true, JSON.stringify(bad));
  }
  assert.equal(paystack.customers.length, 0);
});

// ---------- cash_position, chase_debtor, check_status share one scene ----------

function scene() {
  sheet.seed(
    "Parties",
    { name: "Mrs Bello", kind: "household", phone: "08030000002" },
    household,
    { name: "Eko Events", kind: "event", phone: "08030000003", email: "bookings@ekoevents.example.org" },
    { name: "Mrs Okon", kind: "household", phone: "08030000004" },
    { ...supplier, recipient_code: paystack.recipient("058", "0123454821") },
    { name: "Gas Man", kind: "supplier", bank_code: "044", account_number: "0000000001", account_name: "GAS MAN", recipient_code: paystack.recipient("044", "0000000001") },
  );
  sheet.seed(
    "Ledger",
    { id: "IN-0139", direction: "IN", party: "Mrs Okon", description: "Shopping", amount_ngn: 20000, due_date: "2026-11-10", status: "open", paystack_code: paystack.request(2_000_000) },
    { id: "IN-0140", direction: "IN", party: "Mrs Bello", description: "Shopping", amount_ngn: 45000, due_date: "2026-11-01", status: "open", paystack_code: paystack.request(4_500_000) },
    { id: "IN-0141", direction: "IN", party: "Mrs Adeyemi", description: "Shopping", amount_ngn: 61400, due_date: "2026-11-02", status: "open", paystack_code: paystack.request(6_140_000) },
    { id: "IN-0142", direction: "IN", party: "Eko Events", description: "Wedding balance", amount_ngn: 250000, due_date: "2026-11-03", status: "open", paystack_code: paystack.request(25_000_000), last_chased: "2026-11-04T12:00:00.000Z" },
    { id: "IN-0138", direction: "IN", party: "Mrs Okon", description: "Shopping", amount_ngn: 9000, due_date: "2026-10-20", status: "paid" },
    { id: "OUT-0050", direction: "OUT", party: "Mama Nkechi", description: "Peppers", amount_ngn: 30000, due_date: "2026-10-30", status: "paid", paid_at: "2026-10-30T10:00:00.000Z", paystack_code: "chopiefy-out-0050-1", recipient_code: "RCP_1" },
    { id: "OUT-0057", direction: "OUT", party: "Mama Nkechi", description: "Tomatoes", amount_ngn: 85000, due_date: "2026-11-06", status: "open", approved: false },
    { id: "OUT-0058", direction: "OUT", party: "Gas Man", description: "Gas refill", amount_ngn: 250000, due_date: "2026-11-20", status: "open", approved: false },
  );
  paystack.pay("PRQ_3"); // Mrs Adeyemi paid at Paystack; the Sheet doesn't know yet
}

test("cash_position: refreshes from Paystack, then totals what's owed both ways and what needs approval", async () => {
  scene();
  const ledger = sheet.tabs.Ledger;
  ledger.push(...ledger.splice(ledger.findIndex((r) => r[0] === "IN-0140"), 1)); // out of date order

  const { data } = await call("cash_position");

  assert.equal(data.refreshed, true);
  assert.equal(data.owed_to_us.total, "₦315,000", "Adeyemi's payment is taken out");
  assert.equal(data.owed_to_us.overdue_total, "₦295,000");
  assert.deepEqual(data.owed_to_us.overdue.map((i: Json) => [i.id, i.days_overdue]), [["IN-0140", 4], ["IN-0142", 2]], "oldest first");
  assert.deepEqual(data.we_owe_next_7_days.items.map((i: Json) => i.id), ["OUT-0057"]);
  assert.equal(data.we_owe_next_7_days.total, "₦85,000");
  assert.deepEqual(data.waiting_for_approval.map((i: Json) => i.id), ["OUT-0058"]);
  assert.match(data.waiting_for_approval[0].reason, /per-payment limit/);
  assert.match(data.waiting_for_approval[0].reason, /new bank details/);

  const adeyemi = sheet.rows("Ledger").find((r) => r.id === "IN-0141")!;
  assert.deepEqual([adeyemi.status, adeyemi.paid_at], ["paid", "2026-11-05T08:30:00.000Z"]);
});

test("cash_position: says so when Paystack can't be reached, and still answers from the Sheet", async () => {
  scene();
  paystack.failures["GET /paymentrequest"] = "down";

  const { isError, data } = await call("cash_position");

  assert.equal(isError, false);
  assert.equal(data.refreshed, false);
  assert.equal(data.owed_to_us.total, "₦376,400", "Adeyemi still counted: the Sheet hasn't heard");
});

test("chase_debtor: reminds only who is overdue, unpaid and not chased in 48 hours", async () => {
  scene();

  const { data } = await call("chase_debtor");

  assert.deepEqual(data.reminded.map((r: Json) => r.id), ["IN-0140"]);
  assert.deepEqual(data.already_paid.map((r: Json) => r.id), ["IN-0141"]);
  assert.deepEqual(data.skipped.map((r: Json) => r.id), ["IN-0142"]);
  assert.match(data.skipped[0].reason, /48 hours/);

  const bello = data.reminded[0];
  assert.match(bello.message, /₦45,000/);
  assert.match(bello.message, /4 days overdue/);
  assert.match(bello.message, /https:\/\/paystack\.shop\/pay\/PRQ_2/);
  assert.equal(bello.whatsapp_link, `https://wa.me/2348030000002?text=${encodeURIComponent(bello.message)}`);
  assert.equal(sheet.rows("Ledger").find((r) => r.id === "IN-0140")!.last_chased, new Date(NOW).toISOString());
  assert.equal(sheet.rows("Ledger").find((r) => r.id === "IN-0141")!.status, "paid");
  assert.deepEqual(paystack.notified, [], "Mrs Bello has no email");
});

test("chase_debtor: named invoices only; Paystack's email reminder is sent but never claimed", async () => {
  scene();
  sheet.tabs.Ledger.find((r) => r[0] === "IN-0142")![9] = "2026-11-01T12:00:00.000Z"; // chased 4 days ago

  const { data } = await call("chase_debtor", { invoice_ids: ["IN-0142", "IN-0139"] });

  assert.deepEqual(data.reminded.map((r: Json) => r.id), ["IN-0142", "IN-0139"]);
  assert.doesNotMatch(data.reminded[1].message, /overdue/, "IN-0139 isn't due yet, but staff asked");
  assert.deepEqual(paystack.notified, ["PRQ_4"], "Eko Events has an email, so Paystack is asked to send one");
  assert.ok(!/email/i.test(JSON.stringify(data)), "no claim that an email went out");
});

test("chase_debtor: when Paystack can't be reached, nobody is chased (they may have paid)", async () => {
  scene();
  paystack.failures["GET /paymentrequest"] = "down";

  const { data } = await call("chase_debtor");

  assert.equal(data.reminded.length, 0);
  assert.deepEqual(data.skipped.map((r: Json) => r.id), ["IN-0140", "IN-0141", "IN-0142"]);
  assert.match(data.skipped[0].reason, /couldn't check Paystack/i);
  assert.equal(sheet.rows("Ledger").find((r) => r.id === "IN-0140")!.last_chased, "");
});

test("chase_debtor: refuses invoices it can't chase", async () => {
  scene();

  const { data } = await call("chase_debtor", { invoice_ids: ["OUT-0057", "IN-9999", "IN-0138"] });

  assert.equal(data.reminded.length, 0);
  assert.deepEqual(data.skipped.map((r: Json) => r.id), ["OUT-0057", "IN-9999", "IN-0138"]);
});

test("check_status IN: Paystack's answer is written to the Ledger", async () => {
  scene();

  const { data } = await call("check_status", { invoice_id: "IN-0141" });

  assert.equal(data.status, "paid");
  assert.match(data.detail, /Paystack/);
  assert.equal(sheet.rows("Ledger").find((r) => r.id === "IN-0141")!.status, "paid");
});

test("check_status OUT: a reversed transfer is recorded as reversed", async () => {
  scene();
  paystack.transfers["chopiefy-out-0057-1"] = { reference: "chopiefy-out-0057-1", amount: 8_500_000, recipient: "RCP_1", status: "reversed", transfer_code: "TRF_1" };
  sheet.tabs.Ledger.find((r) => r[0] === "OUT-0057")![7] = "chopiefy-out-0057-1";

  const { data } = await call("check_status", { invoice_id: "OUT-0057" });

  assert.equal(data.status, "reversed");
  assert.equal(sheet.rows("Ledger").find((r) => r.id === "OUT-0057")!.status, "reversed");
});

test("check_status: hand-entered cash is reported as unverified, and unknown IDs are refused", async () => {
  scene();

  const cash = await call("check_status", { invoice_id: "IN-0138" });
  assert.equal(cash.data.status, "paid");
  assert.match(cash.data.detail, /unverified/);

  assert.match((await call("check_status", { invoice_id: "IN-9999" })).data.refused, /isn't in the Ledger/);
});

// ---------- pay_supplier ----------

const ledgerRow = (id: string) => sheet.rows("Ledger").find((r) => r.id === id)!;
function setCell(id: string, column: (typeof COLUMNS.Ledger)[number], value: string | number | boolean) {
  sheet.tabs.Ledger.find((r) => r[0] === id)![COLUMNS.Ledger.indexOf(column)] = value;
}
const transfer = (reference: string, status: string, amount = 8_500_000) =>
  (paystack.transfers[reference] = { reference, amount, recipient: "RCP_1", status, transfer_code: "TRF_0" });

test("pay_supplier: pays a known supplier within limits, and records the transfer", async () => {
  scene();

  const { isError, data } = await call("pay_supplier", { invoice_id: "out-0057" });

  assert.equal(isError, false, data);
  assert.deepEqual([data.id, data.status, data.amount, data.reference], ["OUT-0057", "paid", "₦85,000", "chopiefy-out-0057-1"]);
  assert.equal(data.to, "Guaranty Trust Bank ••••4821 (NKECHI OKAFOR FOODS)");
  assert.ok(!JSON.stringify(data).includes("0123454821"), "the full account number never goes back to chat");
  assert.deepEqual(paystack.transfers["chopiefy-out-0057-1"], {
    reference: "chopiefy-out-0057-1", amount: 8_500_000, recipient: "RCP_1", status: "success", transfer_code: "TRF_1",
  });
  const row = ledgerRow("OUT-0057");
  assert.deepEqual([row.status, row.paystack_code, row.recipient_code, row.paid_at], ["paid", "chopiefy-out-0057-1", "RCP_1", new Date(NOW).toISOString()]);
});

test("pay_supplier: if the Sheet can't store the reference first, no money moves", async () => {
  scene();
  sheet.failWritesAfter = 0;

  const { isError, data } = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(isError, true);
  assert.match(data, /Google Sheet/);
  assert.deepEqual(paystack.transfers, {});
});

test("pay_supplier: asking twice, even at the same moment, pays once", async () => {
  scene();

  const [a, b] = await Promise.all([call("pay_supplier", { invoice_id: "OUT-0057" }), call("pay_supplier", { invoice_id: "OUT-0057" })]);
  const again = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(Object.keys(paystack.transfers).length, 1);
  assert.deepEqual([a.data.status, b.data.status], ["paid", "paid"], "the one Paystack refused as a duplicate reports the first");
  assert.match(again.data.refused, /already paid/);
  assert.equal(ledgerRow("OUT-0057").status, "paid");
});

test("pay_supplier: new bank details or an amount over the limit wait for the owner's tick in the Sheet", async () => {
  scene();

  const waiting = await call("pay_supplier", { invoice_id: "OUT-0058" });

  assert.match(waiting.data.refused, /owner's approval/);
  assert.match(waiting.data.refused, /new bank details/);
  assert.match(waiting.data.refused, /per-payment limit/);
  assert.deepEqual(paystack.transfers, {});
  assert.equal(ledgerRow("OUT-0058").paystack_code, "", "nothing written for a refused payout");

  setCell("OUT-0058", "approved", true); // the owner ticks it
  const paid = await call("pay_supplier", { invoice_id: "OUT-0058" });

  assert.equal(paid.data.status, "paid");
  assert.equal(paystack.transfers["chopiefy-out-0058-1"]!.amount, 25_000_000);
  assert.equal(paystack.transfers["chopiefy-out-0058-1"]!.recipient, "RCP_2");
});

test("pay_supplier: the daily limit counts what went out today in Lagos and payouts still unconfirmed", async () => {
  scene();
  sheet.seed(
    "Ledger",
    { id: "OUT-0051", direction: "OUT", party: "Mama Nkechi", description: "Rice", amount_ngn: 100000, status: "paid", paid_at: "2026-11-04T23:30:00.000Z", paystack_code: "chopiefy-out-0051-1", recipient_code: "RCP_1" },
    { id: "OUT-0052", direction: "OUT", party: "Gas Man", description: "Gas", amount_ngn: 100000, status: "open", paystack_code: "chopiefy-out-0052-1" },
    { id: "OUT-0053", direction: "OUT", party: "Mama Nkechi", description: "Yams", amount_ngn: 100000, status: "paid", paid_at: "2026-11-04T22:30:00.000Z", paystack_code: "chopiefy-out-0053-1", recipient_code: "RCP_1" },
  );
  transfer("chopiefy-out-0052-1", "pending", 10_000_000);

  const { data } = await call("pay_supplier", { invoice_id: "OUT-0057" });

  // 00:30 on the 5th in Lagos counts as today; 23:30 on the 4th doesn't. ₦100,000 paid today, ₦100,000 unconfirmed
  // and this ₦85,000 come to ₦285,000, under the ₦300,000 daily limit. The next ₦20,000 goes over.
  assert.equal(data.status, "paid", JSON.stringify(data));
  sheet.seed("Ledger", { id: "OUT-0059", direction: "OUT", party: "Mama Nkechi", description: "Oil", amount_ngn: 20000, status: "open" });
  const over = await call("pay_supplier", { invoice_id: "OUT-0059" });
  assert.match(over.data.refused, /daily limit/);
  assert.match(over.data.refused, /₦285,000 already paid today/);
});

test("pay_supplier: a hand-edited account number that no longer matches Paystack's recipient is refused", async () => {
  scene();
  sheet.tabs.Parties.find((r) => r[0] === "Mama Nkechi")![COLUMNS.Parties.indexOf("account_number")] = "0123459999";

  const { data } = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.match(data.refused, /bank details/);
  assert.match(data.refused, /owner/);
  assert.deepEqual(paystack.transfers, {});
});

test("pay_supplier: checks a stored reference with Paystack before anything else", async () => {
  scene();
  sheet.seed(
    "Ledger",
    { id: "OUT-0061", direction: "OUT", party: "Mama Nkechi", description: "a", amount_ngn: 1000, status: "open", paystack_code: "chopiefy-out-0061-1" },
    { id: "OUT-0062", direction: "OUT", party: "Mama Nkechi", description: "b", amount_ngn: 1000, status: "open", paystack_code: "chopiefy-out-0062-1" },
    { id: "OUT-0063", direction: "OUT", party: "Mama Nkechi", description: "c", amount_ngn: 1000, status: "failed", paystack_code: "chopiefy-out-0063-2" },
    { id: "OUT-0064", direction: "OUT", party: "Mama Nkechi", description: "d", amount_ngn: 1000, status: "open", paystack_code: "chopiefy-out-0064-1" },
  );
  transfer("chopiefy-out-0061-1", "success", 100_000); // went through; the Sheet never heard
  transfer("chopiefy-out-0062-1", "pending", 100_000);
  transfer("chopiefy-out-0063-2", "failed", 100_000);
  // OUT-0064: the reference was stored but Paystack never saw the transfer

  const [succeeded, pending, failed, unseen] = await Promise.all(
    ["OUT-0061", "OUT-0062", "OUT-0063", "OUT-0064"].map((invoice_id) => call("pay_supplier", { invoice_id })),
  );

  assert.equal(succeeded.data.status, "paid");
  assert.equal(ledgerRow("OUT-0061").status, "paid");
  assert.equal(pending.data.status, "pending");
  assert.match(pending.data.detail, /don't pay again/i);
  assert.equal(failed.data.reference, "chopiefy-out-0063-3", "the next attempt after a failure");
  assert.equal(unseen.data.reference, "chopiefy-out-0064-1", "the same reference, since Paystack never saw it");
  assert.deepEqual(Object.keys(paystack.transfers).sort(), [
    "chopiefy-out-0061-1", "chopiefy-out-0062-1", "chopiefy-out-0063-2", "chopiefy-out-0063-3", "chopiefy-out-0064-1",
  ]);
  assert.deepEqual([ledgerRow("OUT-0063").status, ledgerRow("OUT-0063").paystack_code], ["paid", "chopiefy-out-0063-3"]);
});

test("pay_supplier: a low Paystack balance is refused plainly, and paying after a top-up reuses the reference", async () => {
  scene();
  paystack.failures["POST /transfer"] = { status: 400, code: "insufficient_balance", message: "Your balance is not enough to fulfil this request" };

  const low = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.match(low.data.refused, /top up/i);
  assert.match(low.data.refused, /nothing was sent/i);

  delete paystack.failures["POST /transfer"];
  const paid = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(paid.data.reference, "chopiefy-out-0057-1");
  assert.equal(paid.data.status, "paid");
});

test("pay_supplier: when Paystack doesn't answer, the outcome is unknown and the agent is told to check first", async () => {
  scene();
  paystack.failures["POST /transfer"] = "down";

  const { isError, data } = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(isError, true);
  assert.match(data, /check_status/);
  assert.match(data, /don't pay again/i);
  assert.deepEqual([ledgerRow("OUT-0057").status, ledgerRow("OUT-0057").paystack_code], ["open", "chopiefy-out-0057-1"]);
});

test("pay_supplier: refuses what it can't pay", async () => {
  scene();
  sheet.seed("Parties", { name: "Fish Man", kind: "supplier" });
  sheet.seed("Ledger", { id: "OUT-0060", direction: "OUT", party: "Fish Man", description: "Fish", amount_ngn: 1000, status: "open", approved: true });

  assert.match((await call("pay_supplier", { invoice_id: "IN-0140" })).data.refused, /owed to Chopiefy/);
  assert.match((await call("pay_supplier", { invoice_id: "OUT-9999" })).data.refused, /isn't in the Ledger/);
  assert.match((await call("pay_supplier", { invoice_id: "OUT-0050" })).data.refused, /already paid/);
  assert.match((await call("pay_supplier", { invoice_id: "OUT-0060" })).data.refused, /no bank details on file/, "even with the owner's tick");
  assert.deepEqual(paystack.transfers, {});
});

test("pay_supplier: when the money goes but the Sheet can't record it, the reply says it was paid, and the next call records it", async () => {
  scene();
  sheet.failWritesAfter = 1; // the reference is stored, marking it paid fails

  const first = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(first.isError, false, first.data);
  assert.equal(first.data.status, "paid");
  assert.match(first.data.detail, /couldn't record/);
  assert.equal(ledgerRow("OUT-0057").status, "open");

  sheet.failWritesAfter = Infinity;
  const again = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(again.data.status, "paid");
  assert.equal(ledgerRow("OUT-0057").status, "paid");
  assert.equal(Object.keys(paystack.transfers).length, 1);
});

test("pay_supplier and check_status never mark an invoice paid from a transfer that isn't its own", async () => {
  scene();
  transfer("chopiefy-out-0050-1", "success"); // same amount as OUT-0057, so only the reference gives it away
  setCell("OUT-0057", "paystack_code", "chopiefy-out-0050-1"); // another invoice's reference, typed in by hand
  sheet.seed("Ledger", { id: "OUT-0065", direction: "OUT", party: "Mama Nkechi", description: "Oil", amount_ngn: 100000, status: "open", paystack_code: "chopiefy-out-0065-1" });
  transfer("chopiefy-out-0065-1", "success", 8_500_000); // the amount was edited after the money went

  for (const invoice_id of ["OUT-0057", "OUT-0065"]) {
    for (const tool of ["pay_supplier", "check_status"]) {
      const { data } = await call(tool, { invoice_id });
      assert.equal(data.status, "check", `${tool} ${invoice_id}`);
      assert.match(data.detail, /owner should check/);
      assert.doesNotMatch(data.detail, /paid anything|nothing was sent/i, "money may have moved; never say it didn't");
    }
    assert.equal(ledgerRow(invoice_id).status, "open");
  }
  assert.equal(Object.keys(paystack.transfers).length, 2, "nothing new sent");
});

test("pay_supplier: a transfer status it can't read stops the payout and says who should look", async () => {
  scene();
  setCell("OUT-0057", "paystack_code", "chopiefy-out-0057-1");
  transfer("chopiefy-out-0057-1", "abandoned");

  const { data } = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(data.status, "check");
  assert.match(data.detail, /Paystack dashboard/);
  assert.match(data.detail, /chopiefy-out-0057-2/, "the owner's way out once the dashboard shows no money left");
  assert.equal(Object.keys(paystack.transfers).length, 1);
});

test("pay_supplier: cash the owner marked paid by hand doesn't verify a supplier's bank details", async () => {
  scene();
  sheet.seed("Ledger", { id: "OUT-0054", direction: "OUT", party: "Gas Man", description: "Gas", amount_ngn: 5000, status: "paid", recipient_code: "RCP_2" });
  sheet.seed("Ledger", { id: "OUT-0066", direction: "OUT", party: "Gas Man", description: "Gas", amount_ngn: 5000, status: "open" });

  assert.match((await call("pay_supplier", { invoice_id: "OUT-0066" })).data.refused, /new bank details/);
});

test("pay_supplier: the owner's tick doesn't carry over to bank details changed after an attempt", async () => {
  scene();
  setCell("OUT-0058", "approved", true);
  setCell("OUT-0058", "paystack_code", "chopiefy-out-0058-1");
  setCell("OUT-0058", "recipient_code", "RCP_9"); // the first attempt went to an account Parties no longer holds
  paystack.transfers["chopiefy-out-0058-1"] = { reference: "chopiefy-out-0058-1", amount: 25_000_000, recipient: "RCP_9", status: "failed", transfer_code: "TRF_0" };

  const { data } = await call("pay_supplier", { invoice_id: "OUT-0058" });

  assert.match(data.refused, /changed since OUT-0058 was recorded/);
  assert.equal(Object.keys(paystack.transfers).length, 1);
});

test("pay_supplier: bank details changed in Parties after the invoice was recorded aren't paid on the owner's tick", async () => {
  scene();
  const { data: recorded } = await call("record_invoice", { direction: "OUT", party: "Mama Nkechi", amount_ngn: 150000, description: "Rice", due_date: "2026-11-06" });
  const parties = sheet.tabs.Parties.find((r) => r[0] === "Mama Nkechi")!;
  const at = (c: (typeof COLUMNS.Parties)[number]) => COLUMNS.Parties.indexOf(c);
  [parties[at("bank_code")], parties[at("account_number")], parties[at("recipient_code")]] = ["999992", "0987650011", paystack.recipient("999992", "0987650011")];
  setCell(recorded.id, "approved", true); // over the per-payment limit, ticked by the owner

  const { data } = await call("pay_supplier", { invoice_id: recorded.id });

  assert.match(data.refused, /changed since/);
  assert.deepEqual(paystack.transfers, {});
});

test("pay_supplier: if Paystack calls the reference a duplicate and then can't be reached, the outcome is unknown", async () => {
  scene();
  transfer("chopiefy-out-0057-1", "success"); // sent by a call whose reply was lost before the Sheet heard
  paystack.failures["GET /transfer/verify"] = "down";

  const { isError, data } = await call("pay_supplier", { invoice_id: "OUT-0057" });

  assert.equal(isError, true);
  assert.match(data, /check_status/);
  assert.equal(Object.keys(paystack.transfers).length, 1);
});
