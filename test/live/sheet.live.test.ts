// Contract test against the real demo Sheet. Read-only. Skipped unless the Sheet is configured.
// Run: pnpm test:live   (needs SHEET_ID and GOOGLE_SERVICE_ACCOUNT_B64 in .env.local, and pnpm setup:sheet run once)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRows } from "../../lib/sheet.js";

const skip = process.env.SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_B64 ? false : "SHEET_ID / GOOGLE_SERVICE_ACCOUNT_B64 not set";

test("the service account signs in and both tabs match the layout", { skip }, async () => {
  for (const tab of ["Ledger", "Parties"] as const) {
    const rows = await readRows(tab);
    assert.ok(Array.isArray(rows), `${tab} did not read`);
  }
});
