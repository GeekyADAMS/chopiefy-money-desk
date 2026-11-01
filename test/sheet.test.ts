// Unit tests for the Sheets client (ADR 0009, layout ADR 0010). fetch is mocked: no network, no real key.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, mock, test } from "node:test";
import { appendRow, COLUMNS, readRows, SheetError, updateCells } from "../lib/sheet.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let accounts = 0;

// Each test gets its own service account, so the token cache (keyed by credential) starts empty.
function useAccount() {
  const email = `test-${++accounts}@demo.iam.gserviceaccount.com`;
  process.env.SHEET_ID = "sheet-123";
  process.env.GOOGLE_SERVICE_ACCOUNT_B64 = Buffer.from(
    JSON.stringify({ type: "service_account", client_email: email, private_key: pem }),
  ).toString("base64");
  return email;
}

type Call = { url: string; init: RequestInit };
// Answers Google's token endpoint itself and hands every Sheets call to `sheets`.
function google(sheets: (call: Call) => unknown, expiresIn = 3600) {
  const calls: Call[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: `token-${calls.length}`, expires_in: expiresIn, token_type: "Bearer" });
    }
    calls.push({ url, init });
    const body = sheets({ url, init });
    return body instanceof Response ? body : Response.json(body ?? {});
  });
  const tokenCalls = () => fetch.mock.calls.filter((c) => c.arguments[0] === "https://oauth2.googleapis.com/token");
  return { calls, tokenCalls };
}

const ledgerHeader = [...COLUMNS.Ledger];
const values = (rows: unknown[][]) => ({ values: rows });

afterEach(() => mock.restoreAll());

test("signs in with an RS256 JWT for the spreadsheets scope, and caches the token", async () => {
  const email = useAccount();
  const { calls, tokenCalls } = google(() => values([ledgerHeader]));

  await readRows("Ledger");
  await readRows("Ledger");

  assert.equal(tokenCalls().length, 1, "the second read reuses the token");
  const form = new URLSearchParams(tokenCalls()[0]!.arguments[1]!.body as string);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = form.get("assertion")!.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const c = JSON.parse(Buffer.from(claims!, "base64url").toString());
  assert.equal(c.iss, email);
  assert.equal(c.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert.equal(c.aud, "https://oauth2.googleapis.com/token");
  assert.equal(c.exp - c.iat, 3600);
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature!, "base64url"));
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer token-0");
});

test("gets a new token when the cached one is within a minute of expiring", async () => {
  useAccount();
  const { tokenCalls } = google(() => values([ledgerHeader]), 30);

  await readRows("Ledger");
  await readRows("Ledger");

  assert.equal(tokenCalls().length, 2);
});

test("reads rows keyed by column, with sheet row numbers, blanks filled and empty rows skipped", async () => {
  useAccount();
  const { calls } = google(() =>
    values([ledgerHeader, ["IN-0143", "IN", "Mrs Adeyemi", "Weekly shopping", 61400, "2026-11-04", "open"], [], ["OUT-0057", "OUT"]]),
  );

  const rows = await readRows("Ledger");

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.row, 2);
  assert.equal(rows[0]!.id, "IN-0143");
  assert.equal(rows[0]!.amount_ngn, 61400);
  assert.equal(rows[0]!.approved, "", "missing trailing cells read as empty");
  assert.equal(rows[1]!.row, 4, "row numbers count the skipped empty row");
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/v4/spreadsheets/sheet-123/values/Ledger!A:N");
  assert.equal(url.searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE");
  assert.equal(url.searchParams.get("dateTimeRenderOption"), "FORMATTED_STRING");
});

test("refuses to read a tab whose headers were moved or renamed", async () => {
  useAccount();
  const moved = [...ledgerHeader];
  [moved[4], moved[5]] = [moved[5]!, moved[4]!];
  google(() => values([moved]));

  await assert.rejects(readRows("Ledger"), (err) => err instanceof SheetError && /headers/.test(err.message));
});

test("appends in column order as RAW text, skipping unset cells", async () => {
  useAccount();
  const { calls } = google(() => ({ updates: { updatedRange: "Ledger!A7:N7" } }));

  const row = await appendRow("Ledger", { id: "OUT-0058", party: "=HYPERLINK(\"x\")", amount_ngn: 85000, status: "open" });

  assert.equal(row, 7);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/v4/spreadsheets/sheet-123/values/Ledger!A:N:append");
  assert.equal(url.searchParams.get("valueInputOption"), "RAW", "RAW keeps =… as text, never a formula");
  assert.equal(calls[0]!.init.method, "POST");
  const sent = JSON.parse(calls[0]!.init.body as string).values[0];
  assert.equal(sent.length, COLUMNS.Ledger.length);
  assert.equal(sent[0], "OUT-0058");
  assert.equal(sent[2], "=HYPERLINK(\"x\")");
  assert.equal(sent[4], 85000);
  assert.equal(sent[1], null, "unset cells are null, which Sheets leaves alone");
});

test("updates only the named cells of one row", async () => {
  useAccount();
  const { calls } = google(() => ({}));

  await updateCells("Ledger", 5, { status: "paid", paid_at: "2026-11-01T11:20:41Z" });

  assert.equal(new URL(calls[0]!.url).pathname, "/v4/spreadsheets/sheet-123/values:batchUpdate");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    valueInputOption: "RAW",
    data: [
      { range: "Ledger!G5", values: [["paid"]] },
      { range: "Ledger!L5", values: [["2026-11-01T11:20:41Z"]] },
    ],
  });
});

test("never writes the owner's approval column", async () => {
  useAccount();
  const { calls } = google(() => ({}));

  await assert.rejects(updateCells("Ledger", 5, { approved: true }), /owner/);
  await assert.rejects(appendRow("Ledger", { id: "OUT-0059", approved: true }), /owner/);
  assert.equal(calls.length, 0);
});

test("keeps Google's error message and status, and says to share the Sheet on 403", async () => {
  useAccount();
  google(() => Response.json({ error: { code: 403, message: "The caller does not have permission" } }, { status: 403 }));

  await assert.rejects(readRows("Parties"), (err) =>
    err instanceof SheetError && err.httpStatus === 403 && /does not have permission/.test(err.message) && /Share the Sheet/.test(err.message),
  );
});

test("fails clearly before any network call when the Sheet isn't configured", async () => {
  const { calls, tokenCalls } = google(() => ({}));
  delete process.env.GOOGLE_SERVICE_ACCOUNT_B64;

  await assert.rejects(readRows("Ledger"), /GOOGLE_SERVICE_ACCOUNT_B64/);
  assert.equal(calls.length + tokenCalls().length, 0);
});
