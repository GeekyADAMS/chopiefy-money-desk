// Google Sheets over plain fetch, signed in as a service account (ADR 0009). Layout: ADR 0010.
import { createSign } from "node:crypto";

export const COLUMNS = {
  Ledger: ["id", "direction", "party", "description", "amount_ngn", "due_date", "status", "paystack_code",
    "recipient_code", "last_chased", "paid_at", "created_at", "note", "approved"],
  Parties: ["name", "kind", "phone", "email", "bank_code", "account_number", "account_name", "recipient_code"],
} as const;

export type Tab = keyof typeof COLUMNS;
export type Column<T extends Tab> = (typeof COLUMNS)[T][number];
export type Cell = string | number | boolean;
export type Row<T extends Tab> = { row: number } & Record<Column<T>, Cell>;

// Only the owner approves, by ticking the box in the Sheet (ADR 0010). The server must never write it, and once
// the owner protects it, Google refuses any write that spans it. Owner-only columns therefore come last, and
// appends stop before them.
const OWNER_ONLY = new Set<string>(["approved"]);
const writable = (tab: Tab): readonly string[] => COLUMNS[tab].filter((c) => !OWNER_ONLY.has(c));

export class SheetError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = "SheetError";
  }
}

let cached: { credential: string; token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  const credential = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!credential) throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 is not set (the service account JSON key, base64)");
  if (cached?.credential === credential && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const key = JSON.parse(Buffer.from(credential, "base64").toString()) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!res.ok || !json?.access_token) {
    throw new SheetError(`Google sign-in failed: ${json?.error_description ?? `HTTP ${res.status}`}`, res.status);
  }
  cached = { credential, token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 0) * 1000 };
  return json.access_token;
}

// One call to the Sheets API for our spreadsheet. `path` follows /spreadsheets/{id}, e.g. "/values/Ledger!A:N".
export async function sheets<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error("SHEET_ID is not set");
  const token = await accessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) {
    const message = json?.error?.message ?? `Sheets HTTP ${res.status}`;
    const hint = res.status === 403 ? " Share the Sheet with the service account as Editor." : "";
    throw new SheetError(message + hint, res.status);
  }
  return json as T;
}

const letter = (index: number) => String.fromCharCode(65 + index); // ponytail: A–Z only; our widest tab has 14 columns
const span = (tab: Tab, width: number = COLUMNS[tab].length) => `${tab}!A:${letter(width - 1)}`;

function refuseOwnerOnly(values: object) {
  const blocked = Object.keys(values).filter((c) => OWNER_ONLY.has(c));
  if (blocked.length) throw new Error(`Only the owner can set ${blocked.join(", ")}, by ticking it in the Sheet`);
}

export async function readRows<T extends Tab>(tab: T): Promise<Row<T>[]> {
  const query = "valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
  const { values = [] } = await sheets<{ values?: Cell[][] }>("GET", `/values/${span(tab)}?${query}`);
  const columns: readonly string[] = COLUMNS[tab];
  const header = values[0] ?? [];
  if (header.length !== columns.length || columns.some((c, i) => header[i] !== c)) {
    throw new SheetError(`The ${tab} tab's headers don't match the layout (${columns.join(", ")}). Put them back before going on.`, 409);
  }
  const rows: Row<T>[] = [];
  values.forEach((cells, i) => {
    // A row is real only if it has an ID (or a party name): unticked checkboxes make empty rows read as FALSE.
    if (i === 0 || cells[0] === undefined || cells[0] === "") return;
    rows.push(Object.fromEntries([["row", i + 1], ...columns.map((c, j) => [c, cells[j] ?? ""])]) as Row<T>);
  });
  return rows;
}

// Appends one row and returns its sheet row number. Unset cells are sent as null, which Sheets leaves alone.
export async function appendRow<T extends Tab>(tab: T, values: Partial<Record<Column<T>, Cell>>): Promise<number> {
  refuseOwnerOnly(values);
  const columns = writable(tab);
  const cells = columns.map((c) => (values as Record<string, Cell>)[c] ?? null);
  const res = await sheets<{ updates: { updatedRange: string } }>("POST", `/values/${span(tab, columns.length)}:append?valueInputOption=RAW`, {
    values: [cells],
  });
  return Number(res.updates.updatedRange.match(/(\d+):/)![1]);
}

export async function updateCells<T extends Tab>(tab: T, row: number, values: Partial<Record<Column<T>, Cell>>): Promise<void> {
  refuseOwnerOnly(values);
  const columns: readonly string[] = COLUMNS[tab];
  await sheets("POST", "/values:batchUpdate", {
    valueInputOption: "RAW",
    data: Object.entries(values).map(([c, v]) => ({ range: `${tab}!${letter(columns.indexOf(c))}${row}`, values: [[v]] })),
  });
}
