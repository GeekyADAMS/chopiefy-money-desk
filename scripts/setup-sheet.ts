// Lays out the Ledger and Parties tabs (ADR 0010) in the Sheet named by SHEET_ID. Safe to run again:
// it never overwrites a header row that differs, and the formatting it applies is the same every time.
// Run: pnpm setup:sheet
import { STATUSES } from "../lib/rules.js";
import { COLUMNS, sheets, type Tab } from "../lib/sheet.js";

type Range = { sheetId: number; startColumnIndex?: number; endColumnIndex?: number };
type Meta = { sheets: { properties: { sheetId: number; title: string }; protectedRanges?: { range: Range; warningOnly?: boolean }[] }[] };
const meta = () => sheets<Meta>("GET", "?fields=sheets(properties(sheetId,title),protectedRanges(range,warningOnly))");
const update = (requests: object[]) => sheets("POST", ":batchUpdate", { requests });
const tabs = Object.keys(COLUMNS) as Tab[];

// 1. Tabs: a new spreadsheet's "Sheet1" becomes the Ledger; anything missing is added.
let titles = (await meta()).sheets.map((s) => s.properties);
const create: object[] = [];
for (const tab of tabs) {
  if (titles.some((t) => t.title === tab)) continue;
  const blank = titles.find((t) => t.title === "Sheet1");
  if (tab === "Ledger" && blank) create.push({ updateSheetProperties: { properties: { sheetId: blank.sheetId, title: tab }, fields: "title" } });
  else create.push({ addSheet: { properties: { title: tab } } });
}
if (create.length) await update(create);
titles = (await meta()).sheets.map((s) => s.properties);
const idOf = (tab: Tab) => titles.find((t) => t.title === tab)!.sheetId;

// 2. Header rows: written when the tab has no data yet (so a layout change before go-live just applies), left
// alone when right, and a stop when they differ above real data.
for (const tab of tabs) {
  const { values = [] } = await sheets<{ values?: string[][] }>("GET", `/values/${tab}!1:2`);
  const header = values[0] ?? [];
  const want: readonly string[] = COLUMNS[tab];
  if (header.join() === want.join()) continue;
  if (values.length > 1) {
    throw new Error(`${tab} row 1 is "${header.join(", ")}", expected "${want.join(", ")}". The tab has data, so fix it by hand; nothing was overwritten.`);
  }
  await sheets("POST", "/values:batchUpdate", { valueInputOption: "RAW", data: [{ range: `${tab}!A1`, values: [want] }] });
}

// 3. Is the approved column protected yet? Only the owner can set that up. Once it is, the service account can't
// touch that column, so the Ledger's formatting (applied before protection) is left as it is.
const approved = COLUMNS.Ledger.indexOf("approved");
const ledger = (await meta()).sheets.find((s) => s.properties.title === "Ledger")!;
const isProtected = (ledger.protectedRanges ?? []).some(
  (p) => !p.warningOnly && (p.range.startColumnIndex ?? 0) <= approved && (p.range.endColumnIndex ?? Infinity) > approved,
);

// 4. Formatting and validation, so hand edits stay inside the layout.
const col = <T extends Tab>(tab: T, name: (typeof COLUMNS)[T][number]) => {
  const i = (COLUMNS[tab] as readonly string[]).indexOf(name);
  return { sheetId: idOf(tab), startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 };
};
const oneOf = (range: object, list: readonly string[]) => ({
  setDataValidation: { range, rule: { condition: { type: "ONE_OF_LIST", values: list.map((v) => ({ userEnteredValue: v })) }, strict: true, showCustomUi: true } },
});
const format = (range: object, numberFormat: object) => ({
  repeatCell: { range, cell: { userEnteredFormat: { numberFormat } }, fields: "userEnteredFormat.numberFormat" },
});
const text = { type: "TEXT", pattern: "@" };
// Clearing first means a column that moved doesn't keep its old dropdown or checkbox.
const header = (tab: Tab) => [
  { setDataValidation: { range: { sheetId: idOf(tab), startRowIndex: 1 } } },
  { updateSheetProperties: { properties: { sheetId: idOf(tab), gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
  { repeatCell: { range: { sheetId: idOf(tab), endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
];

await update([
  ...(isProtected ? [] : [
    ...header("Ledger"),
    oneOf(col("Ledger", "direction"), ["IN", "OUT"]),
    oneOf(col("Ledger", "status"), STATUSES),
    { setDataValidation: { range: col("Ledger", "approved"), rule: { condition: { type: "BOOLEAN" }, strict: true } } },
    format(col("Ledger", "due_date"), { type: "DATE", pattern: "yyyy-mm-dd" }),
    format(col("Ledger", "amount_ngn"), { type: "NUMBER", pattern: "#,##0.00" }),
  ]),
  ...header("Parties"),
  oneOf(col("Parties", "kind"), ["household", "event", "supplier"]),
  ...(["phone", "bank_code", "account_number"] as const).map((c) => format(col("Parties", c), text)),
]);

const letter = String.fromCharCode(65 + approved);
console.log("Ledger and Parties tabs are laid out.");
console.log(
  isProtected
    ? `The approved column (${letter}) is protected, so the Ledger's formatting was left as it is.`
    : `NEXT (owner): protect the approved column so only you can tick it. In the Sheet: select column ${letter} of Ledger,
  Data → Protect sheets and ranges → Set permissions → "Only you" → Done. Then run this again to check.`,
);
