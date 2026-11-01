# 0008. WhatsApp first: staff send invoices and reminders with one tap; Paystack emails only real addresses

- Status: Accepted
- Date: 2026-11-01

## Context
The first skill draft had the agent write every invoice and reminder for staff to copy and forward on WhatsApp,
a chore on every message. Email alone doesn't fix it: the owner confirms households mostly ignore email and live
on WhatsApp. Sending WhatsApps to customers from the server is out of reach here:
- WhatsApp lets a business send free-form text only within 24 hours of the customer's last message; a reminder a
  week later needs a Meta-approved template.
- We have not seen Chord start a conversation with a number that hasn't messaged it first.
- The exercise allows only made-up data and no one's personal number.

What Paystack does (test mode, 2026-11-01):
- `send_notification: true` on a payment request emails the invoice and pay link; `paymentrequest/notify` emails a
  reminder. Delivery to a real inbox is being checked.
- Every payment request needs a customer, and every customer needs a valid email. Without a customer the API
  returns HTTP 500 `unknown`. `name@households.chopiefy.invalid` is refused as invalid; `@example.com`, which
  never receives mail, is accepted.

## Decision
- Staff approve, then send with one tap. `record_invoice` and `chase_debtor` return a WhatsApp click-to-chat link
  (`https://wa.me/<customer's number>?text=<message with the pay link>`). Tapping it opens WhatsApp on staff's
  phone with the message typed to the right person; they press send. It comes from Chopiefy's own number, the
  one households already know, and because a person sends it, the 24-hour rule doesn't apply.
- Paystack emails as well, but only to a real address (`send_notification` true, and `notify` on reminders).
  Event clients usually have one; it is a free second channel and a written record.
- A party with no email gets a placeholder at `example.com` and notifications off, so Paystack never mails it.
- The 48-hour reminder limit and "check Paystack before chasing" apply to the tool call, whichever channel is
  used. We record `last_chased` ourselves because Paystack's `notifications` list stays empty.
- Parties need a phone number in international format for the link. Demo data uses made-up numbers.

## Consequences
- No copy and paste: the read-back and the staff member's tap are the two approvals.
- We can't confirm the WhatsApp was actually sent; `last_chased` means "the link was issued". Good enough for the
  48-hour limit, which exists to stop the agent nagging, not to prove delivery.
- The placeholder domain is a demo shortcut. In production use a Chopiefy subdomain with no mail server.
- Upgrade path: if Chord can send WhatsApp templates to customers, `chase_debtor` sends there directly behind the
  same approval, and the link becomes the fallback.

## Alternatives considered
- Staff copy and forward a message the agent writes (the first draft): a chore on every invoice.
- Paystack email only: households don't read it.
- The server sends WhatsApps directly: blocked by the 24-hour window, unverified in Chord, and needs real numbers.
