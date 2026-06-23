# QA Test Guide — WhatsApp Bot Flow Fixes (PR #41)

Manual walkthrough for the bot fixes in `fix/bot-flow-and-stubs`. Run each case
on WhatsApp against the deployed bot. Tick **Pass/Fail** and note anything off.

> Tip: to reset the conversation between cases, type `CANCEL` (when idle it just
> shows the cancel hint) or simply send a greeting to get the main menu.

| # | Area | Steps | Expected result | Pass/Fail | Notes |
|---|------|-------|-----------------|-----------|-------|

### 1. Order lookup — no phantom "no orders" message
1. As a customer **who has at least one past order**, open the menu and tap **📦 Check an order** (or type `STATUS`).
2. **Expected:** You see your list of recent orders (each with its status) followed by the cancel hint. You should **NOT** see "No recent orders found for your number" before the list. ▢ Pass ▢ Fail
3. As a customer **with no orders**, tap **Check an order**.
4. **Expected:** A single message: "No recent orders found for your number…". No empty list. ▢ Pass ▢ Fail

### 2. Bare CANCEL — nothing in progress
1. From a fresh chat (no order being built), type `CANCEL`.
2. **Expected:** "You don't have an order in progress, so there's nothing to cancel right now." plus the hint to cancel a placed order by number (e.g. `CANCEL FP-2026-0010`). It must **NOT** say "Order cancelled." ▢ Pass ▢ Fail

### 3. Bare CANCEL — mid-build (draft) 
1. Start an order: tap **📸 Photo prints**, pick a size (you're now mid-build).
2. Type `CANCEL`.
3. **Expected:** "Okay, I've cleared what you were working on…" and you're back to the start. ▢ Pass ▢ Fail

### 4. Cancel a placed order by number — unpaid
1. Place an order but **do not pay** (leave it at pending payment). Note its number.
2. Type `CANCEL FP-2026-XXXX` (the real number).
3. **Expected:** "Order …​ has been cancelled." ▢ Pass ▢ Fail

### 5. Cancel a placed order by number — paid & still early
1. Use a **paid** order that is still early (paid / awaiting approval / queued / printing).
2. Type `CANCEL FP-2026-XXXX`.
3. **Expected:** "We've received your request to cancel … Our team will review it…" (filed for admin review/refund). ▢ Pass ▢ Fail

### 6. No cancellation on collected/delivered orders
1. Use an order that is **collected / delivered / fulfilled**.
2. Type `CANCEL FP-2026-XXXX`.
3. **Expected:** "Sorry, … is already too far along to cancel." No cancellation request is created. ▢ Pass ▢ Fail

### 7. Cancel a number that isn't yours / doesn't exist
1. Type `CANCEL FP-2026-9999` (not your order).
2. **Expected:** "I couldn't find order … on your account." ▢ Pass ▢ Fail

### 8. Wallet → web redirect
1. From the menu, tap **🧾 Wallet prints**.
2. **Expected:** A message saying wallet prints are designed on the web, with a link ending in `/prints/wallet`. You stay on the menu (no in-chat photo upload starts). ▢ Pass ▢ Fail
3. Open the link → it lands in the web editor in **Wallet** mode. ▢ Pass ▢ Fail

### 9. Mini → web redirect
1. From the menu, tap **🖼 Mini prints**.
2. **Expected:** A message with a link ending in `/prints/mini`; no in-chat upload. ▢ Pass ▢ Fail
3. Open the link → web editor in **Mini** mode. ▢ Pass ▢ Fail

### 10. Passport is stubbed
1. Confirm the main menu does **not** list Passport photos. ▢ Pass ▢ Fail
2. Type `passport`.
3. **Expected:** "Passport photos are temporarily unavailable…" and an offer of the other products. No flow starts. ▢ Pass ▢ Fail

### 11. Single photo prints still work (regression)
1. Tap **📸 Photo prints**, pick a size, follow the upload link, upload 1 photo, choose quantity, and reach checkout.
2. **Expected:** The standard single-print flow is unchanged end-to-end. ▢ Pass ▢ Fail

### 12. Posters still work (regression)
1. Tap **🎨 Posters / wall art**, pick a size, upload, reach checkout.
2. **Expected:** Unchanged. ▢ Pass ▢ Fail

---

**Defect log**

| # | What happened | Expected | Severity | Fixed? |
|---|---------------|----------|----------|--------|
|   |               |          |          |        |
