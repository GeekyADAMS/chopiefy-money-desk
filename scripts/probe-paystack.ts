// Phase 0 risk check: exercises every Paystack call the Money Desk depends on, in test mode,
// and saves each raw response to probe-output/ as field-notes evidence.
// Run: pnpm probe:paystack   (needs PAYSTACK_SECRET_KEY=sk_test_... in .env.local)
import { mkdirSync, writeFileSync } from "node:fs";
import { paystack, PaystackError } from "../lib/paystack.js";

if (!process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_")) {
  console.error("Set PAYSTACK_SECRET_KEY=sk_test_... in .env.local first (test keys only).");
  process.exit(1);
}

const bankCode = process.env.PROBE_BANK_CODE ?? "057";
const accountNumber = process.env.PROBE_ACCOUNT_NUMBER ?? "0000000000";
const email = process.env.PROBE_EMAIL ?? `probe+${Date.now()}@example.com`;
const runId = Date.now();

mkdirSync("probe-output", { recursive: true });
let n = 0;

// Runs one call, records the raw outcome, and returns the data (or undefined on failure).
async function step<T>(name: string, call: () => Promise<T>, summary: (data: T) => string): Promise<T | undefined> {
  const file = `probe-output/${String(++n).padStart(2, "0")}-${name}.json`;
  try {
    const data = await call();
    writeFileSync(file, JSON.stringify({ ok: true, data }, null, 2));
    console.log(`OK   ${name}: ${summary(data)}`);
    return data;
  } catch (err) {
    const detail = err instanceof PaystackError ? { httpStatus: err.httpStatus, body: err.body } : { error: String(err) };
    writeFileSync(file, JSON.stringify({ ok: false, message: (err as Error).message, ...detail }, null, 2));
    console.log(`FAIL ${name}: ${(err as Error).message}${err instanceof PaystackError ? ` (HTTP ${err.httpStatus})` : ""}`);
    return undefined;
  }
}

type Any = Record<string, any>;

// Money OUT: balance, bank lookup, recipient, transfer, duplicate reference, verify.
await step("balance", () => paystack<Any[]>("GET", "/balance"), (d) => d.map((b) => `${b.currency} ${b.balance / 100}`).join(", "));
await step("banks", () => paystack<Any[]>("GET", "/bank?country=nigeria&perPage=100"), (d) =>
  `${d.length} banks; probe bank ${bankCode} ${d.some((b) => b.code === bankCode) ? "found" : "NOT found"}`);
await step("resolve-account", () => paystack<Any>("GET", `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`), (d) => d.account_name);

const recipient = await step("create-recipient", () =>
  paystack<Any>("POST", "/transferrecipient", { type: "nuban", name: "Probe Supplier", account_number: accountNumber, bank_code: bankCode, currency: "NGN" }),
  (d) => `${d.recipient_code}, resolved name: ${d.details?.account_name}`);

const reference = `chopiefy-probe-${runId}`;
if (recipient) {
  const transfer = { source: "balance", amount: 10_000, recipient: recipient.recipient_code, reference, reason: "Chopiefy probe" };
  await step("transfer", () => paystack<Any>("POST", "/transfer", transfer), (d) => `status ${d.status}, reference ${d.reference}`);
  await step("transfer-same-reference", () => paystack<Any>("POST", "/transfer", transfer), (d) => `status ${d.status} (second call with same reference)`);
  await step("transfer-verify", () => paystack<Any>("GET", `/transfer/verify/${reference}`), (d) => `status ${d.status}`);
}

// Money IN: customer, payment request, reminder, fetch, verify, list.
const customer = await step("create-customer", () =>
  paystack<Any>("POST", "/customer", { email, first_name: "Probe", last_name: "Household", phone: "+2348000000000" }),
  (d) => `${d.customer_code} (${d.email})`);

if (customer) {
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const request = await step("create-payment-request", () =>
    paystack<Any>("POST", "/paymentrequest", {
      customer: customer.customer_code,
      due_date: due,
      description: "Probe: weekly shopping",
      line_items: [
        { name: "Rice 50kg", amount: 5_200_000, quantity: 1 },
        { name: "Tomatoes", amount: 940_000, quantity: 1 },
      ],
      send_notification: true,
    }),
    (d) => `${d.request_code}, status ${d.status}, paid ${d.paid}, amount ${d.amount / 100}, link-like fields: ${linkFields(d)}`);

  if (request) {
    const code = request.request_code;
    await step("send-reminder", () => paystack<Any>("POST", `/paymentrequest/notify/${code}`), () => "sent");
    await step("fetch-payment-request", () => paystack<Any>("GET", `/paymentrequest/${code}`), (d) =>
      `status ${d.status}, notifications ${JSON.stringify(d.notifications ?? null)}`);
    await step("verify-payment-request", () => paystack<Any>("GET", `/paymentrequest/verify/${code}`), (d) => `status ${d.status}, paid ${d.paid}`);
  }
  await step("list-pending", () => paystack<Any[]>("GET", "/paymentrequest?status=pending&perPage=5"), (d) => `${d.length} pending`);
}

console.log(`\nRaw responses saved in probe-output/. Payment link fields need checking by hand if none were printed.`);

// The hosted payment link isn't documented in the API spec, so surface any field that looks like one.
function linkFields(d: Any): string {
  const hits = Object.entries(d).filter(([k, v]) => typeof v === "string" && (/url|link/i.test(k) || v.startsWith("http")));
  return hits.length ? hits.map(([k, v]) => `${k}=${v}`).join(" ") : "none";
}
