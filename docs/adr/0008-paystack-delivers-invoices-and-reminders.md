# 0008. Paystack delivers invoices and reminders; staff approve, they don't forward

- Status: Accepted
- Date: 2026-11-01

## Context
The first skill draft had the agent write every invoice and reminder for staff to copy and forward on WhatsApp.
That keeps a person doing the very chore the Money Desk is meant to remove. Three things push the other way from
sending WhatsApps to customers ourselves:
- The exercise allows only made-up data and no one's personal number.
- WhatsApp lets a business send free-form text only within 24 hours of the customer's last message; a reminder a
  week later needs a Meta-approved template.
- We have not seen Chord start a conversation with a number that hasn't messaged it first.

Paystack already delivers both messages: a payment request created with `send_notification: true` emails the
customer the invoice and pay link, and `POST /paymentrequest/notify/{code}` emails a reminder. The probe saw both
calls accepted in test mode. It did not see the emails arrive (the probe customer was `@example.com`), and the
request's `notifications` list stays empty after a reminder.

## Decision
- Staff approve, Paystack sends. The agent reads the invoice or the list of reminders back, and after a yes,
  `record_invoice` creates the payment request with `send_notification: true` and `chase_debtor` calls
  `paymentrequest/notify`.
- Both tools also return a short WhatsApp version of the message. It is optional: for a customer who ignores email,
  staff can send it. Nothing depends on it being sent.
- The 48-hour reminder limit and the "check Paystack before chasing" rule are unchanged. We record `last_chased`
  ourselves because Paystack's `notifications` list doesn't.
- Every billed party needs an email address, since that is where Paystack sends.

## Consequences
- No copy and paste in the normal flow, and the read-back still stops the agent billing the wrong person.
- The email wording is Paystack's template; we control only the description line.
- Open question for the field notes: whether Paystack test mode actually delivers these emails. Check with a test
  customer whose inbox we control before the demo.
- Upgrade path: if Chord can send outbound WhatsApp templates, `chase_debtor` can send there too, behind the same
  approval. That needs real numbers, so it stays out of this exercise.

## Alternatives considered
- Staff forward a message the agent writes (the first draft): a manual step on every invoice and reminder.
- The agent sends WhatsApps to customers directly: blocked by the 24-hour window, unverified in Chord, and against
  the exercise's no-personal-numbers rule.
