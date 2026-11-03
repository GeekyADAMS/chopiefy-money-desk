// The demo script (docs: ADR 0013) at the tool level, on the same scene `pnpm reset:demo` writes. If this passes,
// every step the recording shows has a tool result behind it; the rehearsal then checks the agent's side.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { loadDemo } from "../scripts/demo-scene.js";
import { COLUMNS } from "../lib/sheet.js";
import { callTool as call, fakeWorld, type FakePaystack, type FakeSheet } from "./fakes.js";

let sheet: FakeSheet;
let paystack: FakePaystack;

beforeEach(async () => {
  process.env.MCP_TOKEN = "demo-test-token";
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-05T09:00:00Z") }); // 10:00 Thursday, Lagos
  ({ sheet, paystack } = fakeWorld());
  await loadDemo(sheet, paystack, "2026-11-05");
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

const tick = (id: string) => {
  const row = sheet.tabs.Ledger.find((r) => r[0] === id)!;
  row[COLUMNS.Ledger.indexOf("approved")] = true;
};

test("the demo, step by step", async () => {
  // 0:20 A supplier invoice for a known supplier: recorded, and flagged as bank details never paid before.
  const recorded = (await call("record_invoice", { direction: "OUT", party: "Mama Nkechi", amount_ngn: 120_000,
    description: "Tomatoes and peppers for Bisi's 40th", due_date: "2026-11-06" })).data;
  assert.equal(recorded.id, "OUT-0006", "IDs continue after the scene's");
  assert.equal(recorded.new_bank_details, true);
  assert.match(recorded.account, /Zenith Bank ••••0000/);

  // 0:45 Bill a household: a pay link and a WhatsApp message.
  const billed = (await call("record_invoice", { direction: "IN", party: "Mrs Adeyemi", amount_ngn: 68_400,
    description: "Weekly shopping", due_date: "2026-11-08" })).data;
  assert.equal(billed.id, "IN-0005");
  assert.match(billed.whatsapp_link, /^https:\/\/wa\.me\/2348000000001\?text=/);

  // 1:05 Where do we stand: Mrs Bello's payment is found and reported, the rest totalled.
  const cash = (await call("cash_position")).data;
  assert.deepEqual(cash.just_paid, [{ id: "IN-0002", party: "Mrs Bello", amount: "₦61,400" }]);
  assert.deepEqual(cash.owed_to_us.overdue.map((i: any) => i.id), ["IN-0001", "IN-0003"]);
  assert.equal(cash.owed_to_us.overdue_total, "₦295,000");
  assert.equal(cash.owed_to_us.total, "₦395,400");
  assert.deepEqual(cash.waiting_for_approval.map((i: any) => i.id), ["OUT-0006"]);

  // 1:25 Chase the overdue ones: both reminded, Mrs Bello isn't (she has paid).
  const chase = (await call("chase_debtor")).data;
  assert.deepEqual(chase.reminded.map((r: any) => r.id), ["IN-0001", "IN-0003"]);

  // 1:45 Mrs Adeyemi pays with a test card; asking about her shows it.
  paystack.pay(String(sheet.rows("Ledger").find((r) => r.id === "IN-0005")!.paystack_code));
  assert.equal((await call("check_status", { invoice_id: "IN-0005" })).data.status, "paid");

  // 2:05 Pay Mama Nkechi: held for the owner. Ticked, it pays.
  const held = (await call("pay_supplier", { invoice_id: "OUT-0006" })).data.refused;
  assert.match(held, /new bank details/);
  assert.match(held, /per-payment limit/);
  tick("OUT-0006");
  const paid = (await call("pay_supplier", { invoice_id: "OUT-0006" })).data;
  assert.equal(paid.status, "paid");
  assert.equal(paystack.transfers["chopiefy-out-0006-1"]!.amount, 12_000_000);

  // 2:35 Pay her again: refused, nothing sent.
  assert.match((await call("pay_supplier", { invoice_id: "OUT-0006" })).data.refused, /already paid/);
  assert.equal(Object.keys(paystack.transfers).length, 1);
});
