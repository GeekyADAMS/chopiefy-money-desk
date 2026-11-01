---
name: invoice-review
description: Review invoices against the company expense policy and escalate exceptions to Finance.
---

# Invoice review

## Task
Check a submitted invoice against the company expense policy and decide whether
it can be approved, needs a correction, or should go to Finance.

## When to use it
Use this when someone submits an invoice or an expense claim for approval. Do
not use it for payroll, taxes, or supplier contracts. Those go straight to
Finance.

## Instructions
1. Read the invoice and pull out the supplier, date, currency, total, and line
   items.
2. Check that the invoice has an invoice number and a matching purchase order.
   Flag it if either is missing.
3. Compare each line item against the limits in the rules below.
4. Confirm the total matches the sum of the line items, including tax.
5. Decide one of: approve, return for correction, or escalate to Finance.
6. Write a short note explaining the decision and naming the rule you applied.

## Rules
- Anything over 500,000 NGN goes to Finance, whatever the line items say.
- Travel is capped at 150,000 NGN per trip without prior approval.
- Client entertainment needs the client name and the reason on the invoice.
- Never approve an invoice from a supplier that is not on the approved list.
- If the currency is not NGN, use the rate on the invoice date and show the
  conversion.

## Example of a good result
Input: invoice INV-2291 from Bolt Business, 68,400 NGN, 12 rides, dated
3 September.

Output: Approved. Ground transport for the Lagos sales visit, 68,400 NGN. Under
the 150,000 NGN travel cap, supplier is on the approved list, invoice number and
purchase order both present, and the total matches the line items.
