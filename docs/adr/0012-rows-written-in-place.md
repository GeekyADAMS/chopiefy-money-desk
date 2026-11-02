# 0012. New rows are written in place below the last ID, not appended

- Status: Accepted. Supersedes the "appends write `A:M`" part of [0010](0010-ledger-layout.md)
- Date: 2026-11-02

## Context
ADR 0010 put `approved` last so appends could stop before it. That held until the owner added checkboxes down
column N, as the owner-only tick needs. Google reads an unticked checkbox as `FALSE`, so it treats rows 2 to 1000
as data, and an append, even one narrowed to column A, goes to row 1001. Adding a row spans the protected column,
so Google refuses it ("You are trying to edit a protected cell or object", 2026-11-02, live). The `appendCells`
request behaves the same way.

## Decision
- `addRow` in `lib/sheet.ts` reads column A, writes the new row at the first row below the last ID with
  `values:batchUpdate` (columns A to M only), then reads that row back. If another write landed there first, it
  moves one row down and tries again, up to three times.
- Before writing, `addRow` reads the owner's column on that row. A tick left on an emptied row would approve
  whatever lands there next, so it refuses and asks the owner to untick it (added 2026-11-03).
- Nothing appends to the Ledger. The test fake has no append endpoint, and its Ledger starts with rows of unticked
  checkboxes, like the real one.

## Consequences
- Appends work with the owner's protection and checkboxes in place, and the server still can't touch column N.
- Two writes in the same instant can still collide: if one lands after the other's read-back, the earlier row is
  overwritten. The read-back catches the common order. At one business's volume this is accepted, and noted in
  the code. The upgrade is a lock (an Apps Script web app or a database).
- The Ledger has 1,000 rows. When it fills, the owner adds rows (only they can, since a new row spans column N),
  and `addRow` reports a full sheet as a plain error.

## Alternatives considered
- Owner types TRUE instead of ticking a pre-inserted checkbox: append would work, but it's clumsier for the owner
  and easy to get wrong.
- A separate Approvals tab, protected whole: appends to the Ledger would work, but approving by typing an invoice
  ID into another tab is further from how the owner reads the Ledger.
- Fewer checkbox rows than the sheet has: the append lands after the last checkbox, leaving a gap of empty rows.
