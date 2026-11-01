// Contract tests against Paystack TEST mode over the network. Read-only: moving money is the probe's job.
// Skipped without a key. Run: pnpm test:live   (needs PAYSTACK_SECRET_KEY=sk_test_... in .env.local)
import assert from "node:assert/strict";
import { test } from "node:test";
import { paystack, PaystackError } from "../../lib/paystack.js";

const key = process.env.PAYSTACK_SECRET_KEY;
const skip = key?.startsWith("sk_test_") ? false : "PAYSTACK_SECRET_KEY (sk_test_...) not set";

test("the test key authenticates and the NGN balance is integer kobo", { skip }, async () => {
  const balances = await paystack<{ currency: string; balance: number }[]>("GET", "/balance");
  const ngn = balances.find((b) => b.currency === "NGN");
  assert.ok(ngn, "no NGN balance");
  assert.ok(Number.isInteger(ngn.balance));
});

test("Paystack refuses a bad key with HTTP 401, mapped to PaystackError", { skip }, async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_not_a_real_key";
  try {
    await assert.rejects(paystack("GET", "/balance"), (err) => err instanceof PaystackError && err.httpStatus === 401);
  } finally {
    process.env.PAYSTACK_SECRET_KEY = key;
  }
});
