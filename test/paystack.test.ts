// Unit tests for the Paystack client. fetch is mocked: no network, no keys.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { paystack, PaystackError, toKobo, toNaira } from "../lib/paystack.js";

const KEY = "sk_test_unit";

beforeEach(() => {
  process.env.PAYSTACK_SECRET_KEY = KEY;
});
afterEach(() => mock.restoreAll());

const respond = (status: number, body: unknown) =>
  mock.method(globalThis, "fetch", async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );

test("refuses live and missing keys before any network call", async () => {
  const fetch = respond(200, { status: true, data: {} });

  process.env.PAYSTACK_SECRET_KEY = "sk_live_abc";
  await assert.rejects(paystack("GET", "/balance"), /test key/);
  delete process.env.PAYSTACK_SECRET_KEY;
  await assert.rejects(paystack("GET", "/balance"), /test key/);

  assert.equal(fetch.mock.callCount(), 0);
});

test("sends an authorised JSON request and unwraps data", async () => {
  const fetch = respond(200, { status: true, message: "Transfer queued", data: { transfer_code: "TRF_1" } });

  assert.deepEqual(await paystack("POST", "/transfer", { amount: 100 }), { transfer_code: "TRF_1" });

  const [url, init] = fetch.mock.calls[0]!.arguments;
  const headers = init?.headers as Record<string, string>;
  assert.equal(url, "https://api.paystack.co/transfer");
  assert.equal(init?.method, "POST");
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(init?.body, JSON.stringify({ amount: 100 }));
});

test("GET requests carry no body", async () => {
  const fetch = respond(200, { status: true, data: [] });
  await paystack("GET", "/balance");
  assert.equal(fetch.mock.calls[0]!.arguments[1]?.body, undefined);
});

test("status:false is an error even on HTTP 200", async () => {
  respond(200, { status: false, message: "Invalid key" });
  await assert.rejects(
    paystack("GET", "/balance"),
    (err) => err instanceof PaystackError && err.httpStatus === 200 && err.message === "Invalid key",
  );
});

test("HTTP errors keep Paystack's message and body for the caller", async () => {
  const body = { status: false, message: "Duplicate Transfer Reference" };
  respond(400, body);
  await assert.rejects(
    paystack("POST", "/transfer", {}),
    (err) => err instanceof PaystackError && err.httpStatus === 400 && err.message === body.message && err.body !== null,
  );
});

test("a non-JSON gateway error still becomes a PaystackError", async () => {
  respond(502, "<html>Bad Gateway</html>");
  await assert.rejects(
    paystack("GET", "/balance"),
    (err) => err instanceof PaystackError && err.httpStatus === 502 && err.message === "Paystack HTTP 502",
  );
});

// Money contract: a timeout means "outcome unknown", so it must NOT look like a Paystack refusal.
test("a timeout surfaces as TimeoutError, not PaystackError", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  await assert.rejects(
    paystack("POST", "/transfer", {}),
    (err) => err instanceof Error && err.name === "TimeoutError" && !(err instanceof PaystackError),
  );
});

test("naira to kobo rounds away float error", () => {
  assert.equal(toKobo(19.99), 1999); // 19.99 * 100 = 1998.9999999999998
  assert.equal(toKobo(0.1 + 0.2), 30);
  assert.equal(toKobo(52_000), 5_200_000);
  assert.equal(toNaira(5_200_000), 52_000);
});
