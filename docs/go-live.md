# Going live: a note for the owner

**What it does.** Staff message the Money Desk on WhatsApp to record invoices in and out, see who owes what, chase
late payers and pay suppliers. Paystack moves the money; your Google Sheet is the books.

**What it doesn't do.** Message customers itself: staff send each invoice and reminder with one tap. Connect to
accounting software, run payroll, or approve its own payments.

**Before real customers use it**
- Connect Chopiefy's WhatsApp Business number to the teammate in Chord. Today it runs only in the test simulator.
- Move to live Paystack keys (a small reviewed code change). Your Paystack business must be registered.
- Keep enough in the Paystack balance for suppliers, and set your two limits: per payment and per day.
- Lock the Sheet so only you can tick `approved`, and give staff only the access they need.
- Pilot for 2 weeks with 5 households and 3 suppliers.

**Your one job: the tick.** New bank details, or a payment over a limit, waits until you tick `approved` on its
row. "Oga said it's fine" in chat never counts. Staff message the desk again once you've ticked. If a supplier's bank
details change, a tick isn't enough: confirm the new account by phone, then clear the cells the desk names.

**When things go wrong**
- The Sheet is the truth. If the desk's message and the Sheet disagree, believe the Sheet and tell us.
- A failed payment stays unpaid in the Sheet, and the desk says so. Name one person to be alerted when payouts fail.
- Payments show up when someone asks, not the moment they land.
- If the desk is down, the Sheet still works and you can pay from Paystack by hand.
- Enter cash payments yourself; they show as unverified.

**Customer data.** The Sheet holds names and phone numbers, so Nigeria's Data Protection Act (2023) applies. Limit
who can open it.
