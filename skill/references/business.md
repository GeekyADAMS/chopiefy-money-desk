# Chopiefy money terms

What Chopiefy does is in the Company library. This file covers only how money works for the Money Desk.

## Who owes whom

| Business line | Money in (IN) | Money out (OUT) |
| --- | --- | --- |
| Personal shopping | Households, invoiced after Chopiefy has bought their goods | Market traders, usually paid on the spot |
| Events and catering | Clients pay a deposit, then the balance | Rentals, ingredients, casual staff |
| Restaurants | Customers pay up front, so nothing to chase | Produce, meat, gas and drinks suppliers |
| Online ordering | Paid at checkout, so nothing to chase | Same suppliers as the restaurants |

## Payment terms (use these when no due date is given)
- Household shopping: due 3 days after the shop.
- Event balance: due 7 days before the event date.
- Supplier invoices: due on the date written on the invoice; if there is none, ask.

## The ledger
- Invoice IDs are `IN-` or `OUT-` followed by a number, for example IN-0143 or OUT-0057. Always quote the ID.
- Status is open, part (part-paid), paid, failed or reversed. "Overdue" means open or part-paid after the
  due date, in Lagos time.
- Parties (households, clients, suppliers) are in the Parties tab. Households and event clients need a
  WhatsApp number for their invoice link; if one is missing, ask staff for it. An email is optional: if
  there is one, Paystack emails the invoice and reminders as well.

## Approvals and limits
- The owner sets a per-payment limit and a daily payout limit. The server knows the current values and
  says which one applies when it refuses; don't quote limits from memory.
- A payout to a new supplier, to changed bank details, or over a limit waits until the owner ticks
  `approved` on that row in the Sheet. Nobody else can tick it, including you.

## Chasing etiquette
- Customers get invoices and reminders on WhatsApp from staff's phone. Be polite and short, and always
  include the amount, what it was for, and the pay link.
- Paystack's emails use its own wording; only the description line is ours, so keep it plain
  ("Weekly shopping, 28 Oct").
- First reminder: friendly ("just a gentle reminder"). Later ones: still polite, and mention how many days
  overdue it is.
- Never shame, threaten or copy anyone else in. At most one reminder per invoice every 48 hours; the tool
  enforces this.
- If a debtor says they have paid, thank them and check with `check_status`; never argue.
