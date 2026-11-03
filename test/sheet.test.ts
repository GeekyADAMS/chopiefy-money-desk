// Unit tests for the Sheets client (ADR 0009, layout ADR 0010). fetch is mocked: no network, no real key.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, mock, test } from "node:test";
import { addRow, COLUMNS, readRows, SheetError, updateCells } from "../lib/sheet.js";

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

test("reads rows keyed by column, with sheet row numbers, blanks filled and rows without an ID skipped", async () => {
  useAccount();
  const unticked = [...Array(13).fill(""), false]; // an empty row whose approved checkbox reads FALSE
  const { calls } = google(() =>
    values([ledgerHeader, ["IN-0143", "IN", "Mrs Adeyemi", "Weekly shopping", 61400, "2026-11-04", "open"], unticked, ["OUT-0057", "OUT"], unticked]),
  );

  const rows = await readRows("Ledger");

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.row, 2);
  assert.equal(rows[0]!.id, "IN-0143");
  assert.equal(rows[0]!.amount_ngn, 61400);
  assert.equal(rows[0]!.approved, "", "missing trailing cells read as empty");
  assert.equal(rows[1]!.row, 4, "row numbers count the skipped row");
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

// A fake tab for addRow: column A as Google returns it (trailing empty rows trimmed), and what lands where.
function tab(ids: string[], ticked: number[] = []) {
  const column = [["id"], ...ids.map((id) => (id ? [id] : []))];
  const written: Record<number, unknown[]> = {};
  const handler = ({ url, init }: Call) => {
    const range = decodeURIComponent(new URL(url).pathname).split("/values/")[1] ?? "";
    if (range === "Ledger!A:A") return values(column);
    const owner = range.match(/^Ledger!N(\d+):N\d+$/);
    if (owner) return values([[ticked.includes(Number(owner[1]))]]);
    if (url.endsWith("values:batchUpdate")) {
      const { range: target, values: [cells] } = JSON.parse(init.body as string).data[0];
      const row = Number(target.match(/A(\d+):/)[1]);
      written[row] = cells;
      column[row - 1] = [cells[0]];
      return {};
    }
    const row = Number(range.match(/^Ledger!A(\d+):M\d+$/)![1]);
    return values([written[row]!.map((c) => c ?? "")]);
  };
  return { handler, written, column };
}

test("adds a row below the last ID, as RAW text in column order, skipping unset cells and the owner's column", async () => {
  useAccount();
  const ledger = tab(["IN-0001", "", "IN-0003"]);
  const { calls } = google(ledger.handler);

  const row = await addRow("Ledger", { id: "OUT-0058", party: "=HYPERLINK(\"x\")", amount_ngn: 85000, status: "open" });

  assert.equal(row, 5, "after IN-0003 on row 4, gaps above left alone");
  const write = calls.find((c) => c.url.endsWith("values:batchUpdate"))!;
  const body = JSON.parse(write.init.body as string);
  assert.equal(body.valueInputOption, "RAW", "RAW keeps =… as text, never a formula");
  assert.equal(body.data[0].range, "Ledger!A5:M5", "stops before the owner's column");
  const sent = body.data[0].values[0];
  assert.equal(sent.length, COLUMNS.Ledger.length - 1);
  assert.deepEqual([sent[0], sent[2], sent[4]], ["OUT-0058", "=HYPERLINK(\"x\")", 85000]);
  assert.equal(sent[1], null, "unset cells are null, which Sheets leaves alone");
  assert.ok(!calls.some((c) => c.url.includes(":append")), "never appends: Google's append trips over the checkbox column");
});

test("refuses to write into an empty row that still has the owner's tick, so no invoice arrives approved", async () => {
  useAccount();
  const ledger = tab(["IN-0001"], [3]);
  const { calls } = google(ledger.handler);

  await assert.rejects(addRow("Ledger", { id: "OUT-0002", party: "Mama Nkechi" }), (err) =>
    err instanceof SheetError && /Row 3 .*tick/.test(err.message));
  assert.ok(!calls.some((c) => c.url.endsWith("values:batchUpdate")), "nothing written");
});

test("moves down a row when another write took the row first", async () => {
  useAccount();
  const ledger = tab(["IN-0001"]);
  let raced = false;
  const { calls } = google((call) => {
    const answer = ledger.handler(call);
    if (!raced && call.url.endsWith("values:batchUpdate")) {
      raced = true; // someone else's row lands on row 3 just after ours
      ledger.written[3] = ["IN-0002", "IN", "Someone else"];
      ledger.column[2] = ["IN-0002"];
    }
    return answer;
  });

  const row = await addRow("Ledger", { id: "IN-0002", party: "Mrs Okon" });

  assert.equal(row, 4);
  assert.equal(calls.filter((c) => c.url.endsWith("values:batchUpdate")).length, 2);
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
      { range: "Ledger!K5", values: [["2026-11-01T11:20:41Z"]] },
    ],
  });
});

test("the owner's approval column is last, so new rows never span it once it is protected", () => {
  assert.equal(COLUMNS.Ledger.at(-1), "approved");
});

test("never writes the owner's approval column", async () => {
  useAccount();
  const { calls } = google(() => ({}));

  await assert.rejects(updateCells("Ledger", 5, { approved: true }), /owner/);
  await assert.rejects(addRow("Ledger", { id: "OUT-0059", approved: true }), /owner/);
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
