// Puts the live Sheet back to the demo's starting state (ADR 0013). Run: pnpm reset:demo
// Refuses while any approval tick is set. IDs continue above the highest in the Ledger, because Paystack remembers
// every transfer reference.
import { paystack } from "../lib/paystack.js";
import { lagosDate } from "../lib/rules.js";
import { COLUMNS, readRows, sheets, type Cell } from "../lib/sheet.js";
import { demoScene, MAMA_NKECHI } from "./demo-scene.js";

const PAID_REQUEST = "PRQ_c62ykxhst5e1skq"; // ₦61,400, paid with a test card on 2026-11-01 (field notes)
const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// 1. A reset moves rows, so no tick may be set anywhere in the owner's column, emptied rows included.
const { values: ticks = [] } = await sheets<{ values?: Cell[][] }>("GET", "/values/Ledger!N2:N?valueRenderOption=UNFORMATTED_VALUE");
const ticked = ticks.flatMap((v, i) => (v[0] === true ? [i + 2] : []));
if (ticked.length) stop(`Untick approved on Ledger row ${ticked.join(", ")} first, so no tick lands on a different invoice.`);

const [ledger, parties] = await Promise.all([readRows("Ledger"), readRows("Parties")]);
const first = Math.max(0, ...ledger.map((r) => Number(String(r.id).match(/-(\d+)$/)?.[1] ?? 0))) + 1;

// 2. Mama Nkechi keeps the Paystack recipient she has, so a reset uses none of the 3 daily account lookups.
const known = parties.find((p) => p.recipient_code && String(p.bank_code) === MAMA_NKECHI.bank_code && String(p.account_number) === MAMA_NKECHI.account_number);
const recipient = known
  ? String(known.recipient_code)
  : (await paystack<{ recipient_code: string }>("POST", "/transferrecipient", { type: "nuban", name: MAMA_NKECHI.account_name,
      account_number: MAMA_NKECHI.account_number, bank_code: MAMA_NKECHI.bank_code, currency: "NGN" })).recipient_code;

// 3. The scene, with real payment requests for the open IN rows.
const scene = await demoScene({
  today: lagosDate(new Date()), first, recipient,
  request: async (party, amountKobo, paid) => {
    if (paid) {
      const r = await paystack<{ paid: boolean; amount: number }>("GET", `/paymentrequest/${PAID_REQUEST}`);
      if (!r.paid || r.amount !== amountKobo) stop(`${PAID_REQUEST} isn't a paid request for that amount on this Paystack account.`);
      return PAID_REQUEST;
    }
    const email = `${party.toLowerCase().replace(/[^a-z0-9]/g, "")}@example.com`; // a placeholder that gets no mail (ADR 0008)
    const customer = await paystack<{ customer_code: string }>("POST", "/customer", { email, first_name: party });
    const request = await paystack<{ request_code: string }>("POST", "/paymentrequest",
      { customer: customer.customer_code, amount: amountKobo, description: "Demo invoice", send_notification: false });
    return request.request_code;
  },
});

// 4. Write the scene from row 2, then clear what's below it. A failed write leaves the old rows, never an empty Sheet.
const cells = (columns: readonly string[], rows: Record<string, unknown>[]) => rows.map((r) => columns.map((c) => (r[c] ?? "") as Cell));
const ledgerColumns = COLUMNS.Ledger.filter((c) => c !== "approved");
await sheets("POST", "/values:batchUpdate", { valueInputOption: "RAW", data: [
  { range: `Parties!A2:H${scene.parties.length + 1}`, values: cells(COLUMNS.Parties, scene.parties) },
  { range: `Ledger!A2:M${scene.ledger.length + 1}`, values: cells(ledgerColumns, scene.ledger) },
] });
await sheets("POST", "/values:batchClear", { ranges: [`Parties!A${scene.parties.length + 2}:H`, `Ledger!A${scene.ledger.length + 2}:M`] });

console.log(`Reset: ${scene.parties.length} parties and ${scene.ledger.length} invoices, ${scene.ledger[0]!.id} to ${scene.ledger.at(-1)!.id}.`);
