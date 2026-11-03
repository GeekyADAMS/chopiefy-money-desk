// The demo's starting state (ADR 0013): what `pnpm reset:demo` writes to the Sheet and `pnpm rehearse` loads into
// the fakes. Every person, number and account is made up.
import type { FakePaystack, FakeSheet } from "../test/fakes.js";
import type { Invoice, Party } from "../lib/ledger.js";
import { addDays } from "../lib/ledger.js";
import { toKobo } from "../lib/paystack.js";

type Rows<T> = Partial<Omit<T, "row">>[];
export interface SceneDeps {
  today: string; // Lagos date, YYYY-MM-DD
  first: number; // the first ID number to use, above any already in the Ledger
  recipient: string; // Mama Nkechi's Paystack recipient for Zenith 0000000000
  request: (party: string, amountKobo: number, paid: boolean) => Promise<string>; // a payment request code
}

export const MAMA_NKECHI = { name: "Mama Nkechi", bank_code: "057", account_number: "0000000000", account_name: "Test" };

export async function demoScene({ today, first, recipient, request }: SceneDeps): Promise<{ parties: Rows<Party>; ledger: Rows<Invoice> }> {
  const parties: Rows<Party> = [
    { name: "Mrs Adeyemi", kind: "household", phone: "0800 000 0001" },
    { name: "Mrs Bello", kind: "household", phone: "0800 000 0002" },
    { name: "Mr Okafor", kind: "household", phone: "0800 000 0003" },
    { name: "Mrs Bisi Lawal", kind: "event", phone: "0800 000 0004" },
    { ...MAMA_NKECHI, kind: "supplier", phone: "0800 000 0005", recipient_code: recipient },
    { name: "Gas Depot", kind: "supplier", phone: "0800 000 0006" },
  ];
  let n = first;
  const id = (direction: "IN" | "OUT") => `${direction}-${String(n++).padStart(4, "0")}`;
  const created = `${addDays(today, -14)}T09:00:00.000Z`;
  const bill = async (party: string, description: string, amount: number, due: number, paid = false) => ({
    id: id("IN"), direction: "IN", party, description, amount_ngn: amount, due_date: addDays(today, due), status: "open",
    paystack_code: await request(party, toKobo(amount), paid), created_at: created,
  });
  const ledger: Rows<Invoice> = [
    await bill("Mr Okafor", "Weekly shopping", 45_000, -9),
    await bill("Mrs Bello", "Weekly shopping", 61_400, -6, true), // paid at Paystack; the Sheet hasn't heard
    await bill("Mrs Bisi Lawal", "Small chops balance, 40th birthday (80 guests)", 250_000, -4),
    await bill("Mrs Adeyemi", "Party trays", 32_000, 5),
    { id: id("OUT"), direction: "OUT", party: "Gas Depot", description: "Cooking gas refill", amount_ngn: 38_000,
      due_date: addDays(today, -10), status: "paid", created_at: created, note: "Paid cash by the owner" },
  ];
  return { parties, ledger };
}

// The same scene in the in-memory Sheet and Paystack, for the demo test and `pnpm rehearse`.
export async function loadDemo(sheet: FakeSheet, paystack: FakePaystack, today: string) {
  const scene = await demoScene({
    today, first: 1, recipient: paystack.recipient(MAMA_NKECHI.bank_code, MAMA_NKECHI.account_number),
    request: async (_party, amountKobo, paid) => paystack.request(amountKobo, paid ? "success" : "pending"),
  });
  for (const r of Object.values(paystack.requests)) if (r.paid) r.paid_at = `${addDays(today, -1)}T15:20:00.000Z`; // yesterday, not the fakes' fixed date
  sheet.seed("Parties", ...(scene.parties as Parameters<FakeSheet["seed"]>[1][]));
  sheet.seed("Ledger", ...(scene.ledger as Parameters<FakeSheet["seed"]>[1][]));
}
