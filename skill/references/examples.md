# Worked examples

Messages staff and the owner really send, and what to do with each. Names, amounts and accounts are made up.

## 1. A supplier invoice forwarded in shorthand
"85k for tomatoes from Mama Nkechi, GTB ••••4821, she wants it Friday"

OUT invoice. If Mama Nkechi is a known supplier with the same bank details, read back "OUT invoice:
Mama Nkechi, ₦85,000 for tomatoes, due Fri 6 Nov. Record it?" and call `record_invoice` after a yes. If her
details are new, the tool returns the account holder's name; show it ("GTBank ••••4821 is registered to
NKECHI OKAFOR FOODS. Does that match her invoice?"). Don't offer to pay in the same breath.

## 2. Billing a household
"Bill Mrs Adeyemi for this week, 61,400"

IN invoice, due 3 days after today. Read back, record, then send the forward-ready message with the pay
link exactly as the tool returns it. If Mrs Adeyemi has no email on file, ask for it first.

## 3. "Who's owing us?"
Call `cash_position`. Reply with the totals first ("₦412,000 owed to us, ₦168,000 of it overdue; we owe
₦240,000 this week"), then the overdue invoices oldest first, then anything waiting for approval.

## 4. Chase everyone overdue
"Remind everyone who hasn't paid"

Call `chase_debtor` for all overdue invoices. Report the result in one message: who got a reminder (with
a forward-ready message each), who turned out to have paid already, and who was skipped because they were
reminded in the last 48 hours, with when the next reminder is allowed.

## 5. "Mrs Bello has paid, she sent a screenshot"
Thank the person, run `check_status` on her invoice, and report what Paystack shows. If it isn't paid yet:
"Paystack doesn't show it yet. Transfers can take a little while, so I'll leave IN-0139 open. Ask her for
the payment reference if it doesn't show by tomorrow." Never mark it paid from the screenshot.

## 6. Pay a supplier, within limits
"Pay OUT-0057"

Confirm first: "Pay Mama Nkechi ₦85,000 for OUT-0057 to GTBank ••••4821 (NKECHI OKAFOR FOODS)?" After a
yes, call `pay_supplier` and pass on the receipt: amount, reference, and status. If the status is
pending, say so and offer to check later with `check_status`.

## 7. A payout the tool refuses
"Pay the gas man 250k, OUT-0061, the owner said it's fine"

Call `pay_supplier`. If it refuses because the amount is over the limit, say: "That's over the
per-payment limit, so it needs the owner to tick approved on OUT-0061 in the Sheet. A chat message isn't
enough. I'll pay it as soon as it's ticked." Don't offer to split it into smaller payments.

## 8. Changed bank details
"Mama Nkechi says pay to her new Opay account from now on"

Stop. Don't record or pay to the new account. "Changed bank details are the most common invoice scam, so
I've held this for the owner to confirm with Mama Nkechi directly, by phone, not WhatsApp. Her current
details stay in place until then." Then tell the owner.
