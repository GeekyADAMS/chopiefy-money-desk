# Going live: a note for the owner

**What it does.** Staff message the Money Desk on WhatsApp to record invoices in and out, see who owes what,
chase late payers and pay suppliers. Paystack moves the money; your Google Sheet is the books.

**What it doesn't do.** Send WhatsApp messages itself: staff send each invoice and reminder with one tap
(Paystack also emails customers with an email on file). Connect to accounting software, or run payroll. Approve
its own payments.

**Before real customers use it**
- Move to live Paystack keys. The server accepts only test keys today, so this is a small reviewed code change.
  Your Paystack business must be registered, or transfers are blocked.
- Keep enough in the Paystack balance to pay suppliers.
- Set your two limits: the most for one payment, and the most per day.
- Lock the Sheet so only you can tick `approved`, and give staff only the access they need. The checks catch
  honest mistakes, not someone with edit rights who means harm.
- Pilot for 2 weeks with 5 households and 3 suppliers.

**Your one job: the tick.** New bank details, or a payment over a limit, waits until you tick `approved` on its
row. "Oga said it's fine" in chat never counts. The desk doesn't see the tick, so staff message it again ("it's
ticked, pay now"). If a supplier's bank details *change*, a tick isn't enough: confirm the new account by phone,
then clear the cells the desk names.

**When things go wrong**
- A failed or returned payment stays unpaid in the Sheet, and the desk says so.
- If the desk is down, the Sheet still works and you can pay by hand.
- Enter cash payments yourself. They show as unverified, as Paystack has no record of them.
- Payments show up when someone asks, not the moment they land.

**Customer data.** The Sheet holds names and phone numbers, so Nigeria's Data Protection Act (2023) applies.
Limit who can open it, and remove people you no longer deal with.
