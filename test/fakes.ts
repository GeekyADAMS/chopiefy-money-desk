// In-memory Google Sheets and Paystack behind a mocked fetch, for tool tests through the real MCP endpoint.
// They copy the behaviour we saw in test mode (field notes): the Sheet refuses writes that span the owner's
// protected column, and Paystack refuses a reused transfer reference.
import { generateKeyPairSync } from "node:crypto";
import { mock } from "node:test";
import { POST } from "../api/mcp.js";
import { COLUMNS, type Cell, type Tab } from "../lib/sheet.js";

type Json = Record<string, any>;
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PROTECTED = COLUMNS.Ledger.indexOf("approved");
const col = (letters: string) => letters.charCodeAt(0) - 65;

export class FakeSheet {
  // Like the real Ledger: the owner's checkbox column runs down every row, so empty rows read FALSE in column N.
  tabs: Record<Tab, Cell[][]> = {
    Ledger: [[...COLUMNS.Ledger], ...Array.from({ length: 40 }, () => [...Array(PROTECTED).fill(""), false])],
    Parties: [[...COLUMNS.Parties]],
  };
  failWritesAfter = Infinity; // how many writes succeed before the Sheet starts failing

  // Adds rows by column name into the first row without an ID, as addRow does. Use it to set the scene,
  // including the owner's approved tick.
  seed<T extends Tab>(tab: T, ...rows: Partial<Record<(typeof COLUMNS)[T][number], Cell>>[]) {
    for (const r of rows) {
      const cells = COLUMNS[tab].map((c) => (r as Record<string, Cell>)[c] ?? (tab === "Ledger" && c === "approved" ? false : ""));
      const free = this.tabs[tab].findIndex((row, i) => i > 0 && !row[0]);
      if (free > 0) this.tabs[tab][free] = cells;
      else this.tabs[tab].push(cells);
    }
  }

  // Rows with an ID (or name), as objects, for assertions.
  rows<T extends Tab>(tab: T): Record<(typeof COLUMNS)[T][number], Cell>[] {
    return this.tabs[tab].slice(1).filter((r) => r[0]).map((r) => Object.fromEntries(COLUMNS[tab].map((c, i) => [c, r[i] ?? ""])) as any);
  }

  handle(method: string, url: URL, body: Json | undefined): Response {
    const path = decodeURIComponent(url.pathname.replace(/^\/v4\/spreadsheets\/[^/]+/, ""));
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = path.match(/^\/values\/(\w+)!A:([A-Z])$/))) {
      const rows = this.tabs[m[1] as Tab].map((r) => r.slice(0, col(m![2]!) + 1));
      while (rows.length && rows.at(-1)!.every((c) => c === "")) rows.pop(); // Google trims trailing empty rows
      return Response.json({ values: rows });
    }
    if (method === "GET" && (m = path.match(/^\/values\/(\w+)!([A-Z])(\d+):([A-Z])\d+$/))) {
      const row = this.tabs[m[1] as Tab][Number(m[3]) - 1] ?? [];
      return Response.json({ values: [row.slice(col(m[2]!), col(m[4]!) + 1)] });
    }
    // No append endpoint on purpose: the real one refuses once the owner's checkboxes are in (ADR 0012).
    if (method === "POST" && path === "/values:batchUpdate") {
      if (this.failWritesAfter-- <= 0) return Response.json({ error: { code: 503, message: "The service is currently unavailable." } }, { status: 503 });
      for (const { range, values } of body!.data) {
        const [, tab, from, row, to = from] = range.match(/^(\w+)!([A-Z])(\d+)(?::([A-Z])\d+)?$/)!;
        if (tab === "Ledger" && col(from) <= PROTECTED && col(to) >= PROTECTED) return this.protectedError();
        const rows = this.tabs[tab as Tab];
        while (rows.length < Number(row)) rows.push([]);
        values[0].forEach((v: Cell | null, i: number) => {
          if (v !== null) rows[Number(row) - 1]![col(from) + i] = v;
        });
      }
      return Response.json({});
    }
    throw new Error(`FakeSheet: unexpected ${method} ${path}`);
  }

  private protectedError() {
    return Response.json({ error: { code: 400, message: "You are trying to edit a protected cell or object." } }, { status: 400 });
  }
}

type Transfer = { reference: string; amount: number; recipient: string; status: string; transfer_code: string };

export class FakePaystack {
  banks = [
    { name: "Guaranty Trust Bank", code: "058" },
    { name: "Access Bank", code: "044" },
    { name: "Access Bank (Diamond)", code: "063" },
    { name: "OPay Digital Services Limited (OPay)", code: "999992" },
    { name: "Zenith Bank", code: "057", currency: "NGN" },
    { name: "Zenith Bank", code: "057", currency: "USD" }, // Paystack lists Zenith's dollar accounts too (seen live)
  ];
  accounts: Record<string, string> = { "058:0123454821": "NKECHI OKAFOR FOODS", "999992:0987650011": "N OKAFOR", "057:0000000000": "Test" };
  customers: Json[] = [];
  requests: Record<string, Json> = {};
  notified: string[] = [];
  recipients: Record<string, Json> = {};
  transfers: Record<string, Transfer> = {};
  nextTransferStatus = "success";
  // "METHOD /path-prefix" → a Paystack error to return, or "down" for a network failure.
  failures: Record<string, { status: number; code: string; message: string } | "down"> = {};

  // Test helpers that change state behind the server's back, as a payer or the bank would.
  request(amountKobo: number, status = "pending"): string {
    const code = `PRQ_${Object.keys(this.requests).length + 1}`;
    this.requests[code] = { request_code: code, amount: amountKobo, status, paid: status === "success", paid_at: status === "success" ? "2026-11-04T09:00:00.000Z" : null };
    return code;
  }
  pay(code: string) {
    Object.assign(this.requests[code]!, { status: "success", paid: true, paid_at: "2026-11-05T08:30:00.000Z" });
  }
  recipient(bankCode: string, accountNumber: string): string {
    const found = Object.values(this.recipients).find((r) => r.details.bank_code === bankCode && r.details.account_number === accountNumber);
    if (found) return found.recipient_code;
    const code = `RCP_${Object.keys(this.recipients).length + 1}`;
    this.recipients[code] = { recipient_code: code, name: this.accounts[`${bankCode}:${accountNumber}`] ?? "TEST", details: { bank_code: bankCode, account_number: accountNumber } };
    return code;
  }

  handle(method: string, url: URL, body: Json | undefined): Response {
    const path = url.pathname;
    for (const [key, failure] of Object.entries(this.failures)) {
      const [m, prefix] = key.split(" ");
      if (m !== method || !path.startsWith(prefix!)) continue;
      if (failure === "down") throw new TypeError("fetch failed");
      return Response.json({ status: false, message: failure.message, code: failure.code }, { status: failure.status });
    }
    const ok = (data: unknown) => Response.json({ status: true, message: "ok", data });
    const notFound = (message: string) => Response.json({ status: false, message }, { status: 404 });
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/bank") return ok(this.banks.map((b) => ({ ...b, active: true })));
    if (method === "GET" && path === "/bank/resolve") {
      const name = this.accounts[`${url.searchParams.get("bank_code")}:${url.searchParams.get("account_number")}`];
      return name
        ? ok({ account_name: name, account_number: url.searchParams.get("account_number") })
        : Response.json({ status: false, message: "Could not resolve account name. Check parameters or try again." }, { status: 422 });
    }
    if (method === "POST" && path === "/customer") {
      const customer = { email: body!.email, customer_code: `CUS_${this.customers.length + 1}` };
      this.customers.push(customer);
      return ok(customer);
    }
    if (method === "POST" && path === "/paymentrequest") {
      const code = this.request(body!.amount);
      Object.assign(this.requests[code]!, { customer: body!.customer, description: body!.description, due_date: body!.due_date, send_notification: body!.send_notification });
      return ok(this.requests[code]);
    }
    if (method === "POST" && (m = path.match(/^\/paymentrequest\/notify\/(\w+)$/))) {
      this.notified.push(m[1]!);
      return ok(undefined);
    }
    if (method === "GET" && (m = path.match(/^\/paymentrequest\/(\w+)$/))) {
      return this.requests[m[1]!] ? ok(this.requests[m[1]!]) : notFound("Payment request not found");
    }
    if (method === "POST" && path === "/transferrecipient") {
      return ok(this.recipients[this.recipient(body!.bank_code, body!.account_number)]);
    }
    if (method === "GET" && (m = path.match(/^\/transferrecipient\/(\w+)$/))) {
      return this.recipients[m[1]!] ? ok(this.recipients[m[1]!]) : notFound("Recipient not found");
    }
    if (method === "POST" && path === "/transfer") {
      if (this.transfers[body!.reference]) {
        return Response.json({ status: false, message: "Please provide a unique reference. Reference already exists on a transfer", code: "duplicate_transfer_reference" }, { status: 400 });
      }
      const transfer = { reference: body!.reference, amount: body!.amount, recipient: body!.recipient, status: this.nextTransferStatus, transfer_code: `TRF_${Object.keys(this.transfers).length + 1}` };
      this.transfers[body!.reference] = transfer;
      return ok(transfer);
    }
    if (method === "GET" && (m = path.match(/^\/transfer\/verify\/([\w-]+)$/))) {
      return this.transfers[m[1]!] ? ok(this.transfers[m[1]!]) : notFound("Transfer not found");
    }
    throw new Error(`FakePaystack: unexpected ${method} ${path}`);
  }
}

// Routes fetch to the fakes. Sets the env the server needs; call inside a test, restore with mock.restoreAll().
export function fakeWorld() {
  const sheet = new FakeSheet();
  const paystack = new FakePaystack();
  Object.assign(process.env, {
    SHEET_ID: "sheet-test",
    GOOGLE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify({ client_email: "tools@demo.iam.gserviceaccount.com", private_key: pem })).toString("base64"),
    PAYSTACK_SECRET_KEY: "sk_test_fake",
    PAYOUT_LIMIT_NGN: "100000",
    DAILY_LIMIT_NGN: "300000",
  });
  mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "fake", expires_in: 3600 });
    if (url.host === "sheets.googleapis.com") return sheet.handle(method, url, body);
    if (url.host === "api.paystack.co") return paystack.handle(method, url, body);
    throw new Error(`fakeWorld: unexpected fetch ${url}`);
  });
  return { sheet, paystack };
}

// One tool call through the real MCP endpoint, with the MCP_TOKEN in the environment. Refusals come back as data.
let rpcId = 0;
export async function callTool(name: string, args: Json = {}): Promise<{ isError: boolean; data: any }> {
  const res = await POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.MCP_TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const json = (await res.json()) as Json;
  if (json.error) return { isError: true, data: json.error.message };
  const text = json.result.content[0].text as string;
  return json.result.isError ? { isError: true, data: text } : { isError: false, data: JSON.parse(text) };
}
