# FusionPrints — End-to-End Manual Test Guide

A step-by-step walkthrough of everything to test across both customer channels (WhatsApp bot + web storefront) plus the operator/admin side. Work through it top to bottom, tick each result, and jot fixes in the **Defect log** at the bottom.

_Last updated: 2026-06-19._

**How to use this guide**
- Each case has **Steps**, an **Expected result**, and a **Result** line: mark `PASS` / `FAIL` and add notes.
- A failed case isn't a blocker to continue — note it and move on.
- IDs: `WA-##` WhatsApp · `WEB-##` web storefront · `OPS-##` operator/admin · `X-##` cross-cutting.

---

## 0. Test environment & prerequisites

You can test against **local** (recommended for note-taking — safe, no real money) or **production** (real, only once vendor accounts are live).

### Local setup
1. **Database up + seeded:**
   - `npm run db:reset && npm run db:seed` (gives you the 2 printers, store settings = 6×8, and ZW holidays).
2. **Backend API running:** `npm run dev` → listens on **http://localhost:3000** (admin lives here at `/admin`).
3. **Web storefront running:** in the `fusionprints-web` repo, start its dev server (default **http://localhost:3001**) pointed at the backend. _(Exact command in the Web section.)_
4. **Payment mode:** set `PAYMENT_PROVIDER=stub` in the backend `.env` for safe testing — checkout gets a **mock "confirm payment"** step (no real money). To test the *real* Payonify UI instead, use **test keys** (`pk_test_…/sk_test_…`) and set `PAYMENT_PROVIDER=payonify`.
5. **Virtual printers:** with no real hardware, the seeded printers run virtually, so you can watch jobs move through `queued → printing → printed` in admin.

### Completing the payment step during testing (no real money)
- **Web (stub mode):** the checkout's payment step is a mock — click **Pay / Confirm** and choose success.
- **Web (Payonify test keys):** pay in the Drop-In with a Payonify **test** EcoCash number / test card.
- **WhatsApp (local):** the EcoCash push is simulated and the order stays *pending payment*; mark it paid from the operator side (see **OPS-05**) to carry the order through fulfilment.
- **Production:** real EcoCash PIN on a real phone → Payonify confirms automatically.

### Test data
- **Test WhatsApp number (local sim):** any, e.g. `+263771000001`.
- **Test EcoCash number (EcoNet):** `0772123456` (or any valid 077/078 EcoNet number).
- **Photo to upload:** a high-res image (≥ ~2–3 MP) for a clean pass; keep a small/low-res one handy for the validation cases.

---

## 1. Channel 1 — WhatsApp bot

The bot brain (conversation, validation, ordering, payment) is identical whether driven over real WhatsApp or the local simulator. Pick one:

- **Option A — Real WhatsApp (production-like):** message the FusionPrints WhatsApp number. Requires 360dialog connected + the number approved. This is the only way to test the *real* chat transport, buttons/lists, image delivery, and the outbound confirmation message.
- **Option B — Local simulator:** `npx tsx scripts/simulate-bot-db.ts`. Type messages; use `/image 3024 4032` to simulate a good photo upload, `/compressed 800 600` for a compressed one, `/db orders` to see created orders. Runs the real state machine against the database. _(Outbound "sent" messages aren't delivered to a phone here — you read the bot's replies in the terminal.)_

> In the steps below, "send X" = type X (or tap the matching button on real WhatsApp). Menu numbers shown match the bot's numbered options.

### WA-01 — Greeting & main menu
- **Steps:** Start a fresh chat; send `hi`.
- **Expected:** Friendly FusionPrints greeting and a product menu (photo prints / posters / composite products) with numbered/buttoned options.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-02 — Choose product & size
- **Steps:** Choose **Photo prints** (`1`); then choose the first size (`1`).
- **Expected:** After product → a size menu showing sizes in **inch + cm** with prices; after size → an upload-mode prompt.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-03 — Upload a good photo
- **Steps:** Choose **single image** upload (`1`); send a good photo (`/image 3024 4032` in the sim, or send a real high-res photo).
- **Expected:** Photo accepted (no quality warning); bot asks for **quantity**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-04 — Image validation: low-res / compressed
- **Steps:** Repeat WA-02→WA-03 but send a low-res/compressed image (`/lowres 600 400` or `/compressed 800 600`).
- **Expected:** Bot warns the image is below the recommended resolution / looks compressed, and lets you proceed anyway or send a better one. Wording is clear and non-blocking.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-05 — Quantity & cart
- **Steps:** Enter a quantity (e.g. `10`).
- **Expected:** Item added to cart at the right unit price; a **bulk discount** applies at 10+ (15%) — check the line total. Bot offers **add more** or **checkout**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-06 — Add a second item (multi-item cart)
- **Steps:** Choose **add more**, add a different size/photo, then checkout.
- **Expected:** Cart holds both items; totals sum correctly.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-07 — Name capture (new customer)
- **Steps:** As a brand-new number, proceed to checkout.
- **Expected:** Bot asks for your name before continuing (returning customers skip this).
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-08 — Fulfilment: collection
- **Steps:** At checkout choose **collection** (`1`).
- **Expected:** No address asked; goes straight to the order summary. No delivery fee.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-09 — Fulfilment: delivery + address + fee
- **Steps:** Start another order; choose **delivery**; enter an address.
- **Expected:** Bot captures the address (keeps your casing) and adds the correct **delivery fee** ($3 CBD/Avondale, $5–7 greater Harare). Summary reflects the fee.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-10 — Order summary & confirm
- **Steps:** Review the summary; send `PAY` (or `YES`/`CONFIRM`).
- **Expected:** Order is created (you get an order number `FP-2026-####`); bot moves to **choose payment method**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-11 — Payment method: card is unavailable
- **Steps:** Choose **Card** (`CARD`).
- **Expected:** Bot says card isn't available yet and keeps you on EcoCash (no dead link).
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-12 — EcoCash number validation
- **Steps:** Choose **EcoCash** (`1`); enter a non-EcoNet number (e.g. a NetOne `071…`), then an invalid format, then a valid one (`0772123456`).
- **Expected:** Wrong-network and bad-format inputs are rejected with a clear re-prompt; the valid EcoNet number is accepted and normalised to `+263…`.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-13 — EcoCash push & confirmation
- **Steps:** After a valid number, the USSD push is sent. **Production:** approve the PIN on the phone. **Local:** mark the order paid via **OPS-05**.
- **Expected:** On confirmation the customer gets a **"Payment received"** message; photo orders go to the queue, posters note a quality check first.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-14 — 5×7 next-working-day handling
- **Steps:** Place an order that includes a **5×7** print; complete payment.
- **Expected:** The confirmation/summary tells the customer the order is ready the **next working day** (skips Sundays + ZW public holidays). The whole order is dated, not just the 5×7.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-15 — Composite products
- **Steps:** Choose a **composite** product — wallet or passport (1 photo) and the mini (2 photos). Provide the required photo(s).
- **Expected:** Bot collects the right number of photos per layout and prices the composite correctly.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-16 — Order status lookup
- **Steps:** After ordering, ask for order **status** (e.g. send `status`).
- **Expected:** Bot returns the latest order's status for your number.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-17 — Global commands: BACK / CANCEL / HELP
- **Steps:** Mid-flow, try `BACK`, `HELP`, and `CANCEL`.
- **Expected:** `BACK` steps back one stage; `HELP` shows guidance without losing the order; `CANCEL` (from a destructive point) asks to confirm and cancels cleanly.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-18 — Reset-word guard / mid-order "hi"
- **Steps:** Part-way through an order (e.g. after uploading photos), send `hi`.
- **Expected:** The bot does **not** silently discard your in-progress order/cart; it keeps context (only an explicit restart clears it).
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WA-19 — Wrong input re-prompts
- **Steps:** At various steps, send gibberish or an out-of-range number.
- **Expected:** Bot re-prompts helpfully without crashing or advancing.
- **Result:** ☐ PASS ☐ FAIL — Notes:

---

## 2. Channel 2 — Web storefront

The storefront is the **`fusionprints-web`** app (Next.js). Run it pointed at the backend.

**Setup**
- Backend running on **:3000** (this repo, `npm run dev`).
- ⚠️ The storefront also defaults to **:3000** — run it on a **different port** so they don't collide, e.g. `PORT=3001 npm run dev` in `fusionprints-web`. Open **http://localhost:3001**.
- `fusionprints-web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:3000` (backend), and `NEXT_PUBLIC_PAYONIFY_PUBLISHABLE_KEY` = a Payonify **test** key (leave empty to get the mock "Approve payment" step instead).

> Tip: if `NEXT_PUBLIC_PAYONIFY_PUBLISHABLE_KEY` is empty / no `clientSecret` comes back, checkout shows a **"Demo payment. No real charge is made."** step with **Approve payment / Decline** — the easiest way to complete an order in testing.

### WEB-01 — Landing page
- **Steps:** Open `http://localhost:3001/`.
- **Expected:** Hero with collections (Photo Prints, Wall Art, Photo Sets) and CTAs **"Start an order"** + **"Order on WhatsApp"**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-02 — Browse catalog & product detail
- **Steps:** Click **"Start an order"** → `/prints`. Open a size (e.g. `/prints/5x7`).
- **Expected:** Sizes shown in inch+cm with prices and a glossy/lustre finish guide; product detail shows price, min/recommended resolution, "Start printing" CTA.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-03 — Sign-up + email verification
- **Steps:** From `/signup`, create an account (email, password ≥ 8 chars, optional WhatsApp number) → **"Create account"**. Follow the **`/verify?token=…`** link from the email.
- **Expected:** "Check your inbox" after signup; verification link shows **"You're verified"** and redirects to `/account`. An invalid/expired token shows **"Link expired"**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-04 — Sign-in (and unverified / wrong-password guards)
- **Steps:** Log out, then `/login`. Try a wrong password; try an unverified account; then log in correctly.
- **Expected:** **"Incorrect email or password."** for bad creds; **"Please verify your email first…"** for unverified; success redirects home and shows the account avatar.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-05 — Google sign-in
- **Steps:** Use **"Continue with Google"**.
- **Expected:** Completes OAuth and returns signed-in; a failed attempt shows **"We couldn't sign you in with Google…"**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-06 — Editor: upload a photo
- **Steps:** From a product, **"Start printing"** → `/editor/new?size=…` (signed-out users get bounced to login first). Use **"Add photos" → "Upload from device"** (also try **"Choose from My Photos"**, and **"Google Photos"** if enabled).
- **Expected:** Photo appears in the strip; you can pick it + a size; paper finish (Glossy / Satin-Lustre) and quantity controls are present.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-07 — Editor: crop & adjust
- **Steps:** Open **"Edit / Crop"**. Try reposition, zoom, rotate, flip, an adjustment slider, and a filter; note the dashed **safe-area** outline; **Save**.
- **Expected:** Crop modal works smoothly; safe-area is visible; saved render reflects the edit.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-08 — Editor: low-resolution warning
- **Steps:** Add a small/low-res photo for a larger size.
- **Expected:** Amber **"This photo may be too small…"** or red **"This photo is too small…"** warning in the crop modal.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-09 — Cart review
- **Steps:** **"Review & cart"** → `/cart`. Adjust quantities (+/−) and remove an item.
- **Expected:** Items list with thumbnails; summary subtotal updates; **"Proceed to checkout"** present; empty cart shows **"Your cart is empty"** + **"Browse prints"**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-10 — Checkout: contact + collection
- **Steps:** `/checkout`. Choose **Collection**. Enter the WhatsApp phone (international input; try an invalid number first).
- **Expected:** Invalid phone blocks **"Continue to payment"**; valid phone enables it; collection shows the free-pickup note, no delivery fee.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-11 — Checkout: delivery zones + address + fee
- **Steps:** Start another checkout; choose **Delivery**. Test each zone: **City centre ($3)**, **Greater area ($5)**, **Outside area (quoted)**. Add a new address (recipient, address line, city required) and select it.
- **Expected:** Summary delivery fee updates per zone; outside-area shows the "quoted separately" note; address form validates required fields; **"Continue to payment"** stays disabled until phone + address are set.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-12 — Payment: unedited-item guard
- **Steps:** Reach `/checkout/payment` with an item that was never cropped/edited.
- **Expected:** Red banner **"[N] item(s) still need cropping…"** and the **"Pay"** button is disabled until fixed.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-13 — Payment: complete the order
- **Steps:** On `/checkout/payment`, click **"Pay $[amount]"**.
  - *Mock mode:* choose **"Approve payment"**.
  - *Payonify test mode:* complete EcoCash/card in the Drop-In modal.
- **Expected:** On success, redirect to **`/account/orders/[orderNumber]?placed=1`** with the green "Thank you!" banner. For EcoCash, a "Confirming your payment…" poll appears briefly. **Decline** / failure shows a retry path.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-14 — Order detail + status timeline
- **Steps:** On the order detail page, review the timeline and items.
- **Expected:** Milestones fill in order (Order placed → Payment confirmed → In production → Ready → Completed); status badge + label match (e.g. "Pending payment" amber → "Paid" green); items, subtotal, delivery, total all correct.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-15 — 5×7 next-working-day messaging
- **Steps:** Place an order containing a **5×7**.
- **Expected:** Payment page shows the **"✨ …ready the next day…"** notice; order detail shows **"✨ Your order is special — it'll be ready for [collection/delivery] on [date]."** with a real date.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-16 — Composite products (Photo Sets)
- **Steps:** Order a **wallet** / **mini** / **passport** set (`/prints/wallet|mini|passport`).
- **Expected:** Correct number of photos collected per layout; priced as a composite; flows through checkout like a normal order.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-17 — Order history & empty state
- **Steps:** Open `/account/orders`.
- **Expected:** Lists orders with status/date/count/price; rows open detail. A new account shows **"No orders yet."** + **"Start an order"**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-18 — Address book
- **Steps:** `/account/addresses` — add, edit, set default, remove an address.
- **Expected:** Default is auto-selected at checkout; deleting the default promotes another; changes persist.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-19 — Photo upload limit
- **Steps:** Try adding more than 30 photos to one editor project.
- **Expected:** Blocked with **"You can add up to 30 photos per project…"**.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### WEB-20 — Session persistence
- **Steps:** Log out and back in; revisit the cart/checkout.
- **Expected:** Auth state is correct after re-login; checkout selection restores from where you left off (unless the cart changed).
- **Result:** ☐ PASS ☐ FAIL — Notes:

---

## 3. Operator / Admin verification

Admin is served by the backend at **http://localhost:3000/admin** (production: your admin domain). Sign in at **`/admin/login`** with `ADMIN_USERNAME` / `ADMIN_PASSWORD` (operator role is the limited store-attendant login). Because printers run virtually in local testing, you can watch the whole fulfilment flow without hardware.

### OPS-01 — Admin login
- **Steps:** Go to `/admin/login`; sign in.
- **Expected:** Lands on the dashboard; bad credentials are rejected (and rate-limited on repeat).
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-02 — Orders list & detail
- **Steps:** Open the orders list; click a test order.
- **Expected:** Order shows number, status, items, totals, fulfilment method, customer/contact, and print jobs.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-03 — Poster approval gate
- **Steps:** Place an order with a **poster** (requires manual review); pay; open it in admin.
- **Expected:** Order sits in **awaiting approval**; an **Approve for printing** action releases it to the queue.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-04 — Fulfilment flow (collection & delivery)
- **Steps:** Take a paid photo order through the queue: watch it print (virtual), then **Release for pickup** (collection) or **Mark out for delivery** (delivery).
- **Expected:** Status transitions are correct and the customer-facing "ready"/"out for delivery" notification fires.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-05 — Manual mark-paid (test completion / missed webhook)
- **Steps:** For a *pending payment* order, trigger the admin **mark-paid** action (`POST /admin/api/ops/orders/:id/mark-paid`). _(Note whether there's a button for this in the UI or if it has to be called directly — flag if missing.)_
- **Expected:** Order flips to **paid**, print jobs + slips are created, and the confirmation notification fires — same as a real payment.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-06 — 5×7 DNP media toggle
- **Steps:** Place + pay a **5×7** order. In the ops view, find the **DNP media** bar — it should show the **held 5×7 count** and a **"Switch to 5×7 & print held batch"** button, plus a "regular prints paused" state when in 5×7 mode. Toggle to 5×7, then back to 6×8.
- **Expected:** Switching to 5×7 releases the held 5×7 jobs and **pauses** the 4×6/6×8 family; switching back resumes regular prints and re-holds any remaining 5×7s. Held count is accurate.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-07 — Reprint a failed job
- **Steps:** If a job shows **failed**, use **Reprint** (single or batch).
- **Expected:** A fresh job is queued; original order is unaffected.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### OPS-08 — Pricing & promos (admin-editable)
- **Steps:** Open admin pricing/promos; change a price or promo; place a new quote/order.
- **Expected:** New order reflects the updated price/promo; existing orders are untouched.
- **Result:** ☐ PASS ☐ FAIL — Notes:

---

## 4. Cross-cutting checks

### X-01 — Notifications fire at the right moments
- **Expected:** Payment received, ready-for-collection / out-for-delivery messages each send once, with correct order number and copy. _(Operator 5×7 alert needs `OPERATOR_WHATSAPP_PHONE` set — see project tasks.)_
- **Result:** ☐ PASS ☐ FAIL — Notes:

### X-02 — Slips are generated on payment
- **Steps:** After a paid order, check the slip jobs (order info / separator / envelope label).
- **Expected:** Three slips queue per order without blocking fulfilment.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### X-03 — Abandoned checkout auto-cancel
- **Steps:** Create an order, never pay; (production) leave it ~24h.
- **Expected:** It auto-cancels after 24h and is no longer dispatchable.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### X-04 — Bulk discount & delivery-fee maths
- **Expected:** 10–49 prints = 15% off, 50+ = 25% off; delivery fees match the zone. Cross-check a couple of totals by hand.
- **Result:** ☐ PASS ☐ FAIL — Notes:

---

## 4b. Cancellation & refund (PR-12)

> Needs a **paid** order to act on. Easiest: place a small real card order (or use a virtual-payment order on staging). The Payonify refund endpoint is best-guess — **REF-01 is the live verification** that confirms the real refund works end to end.

### CR-01 — Customer requests cancellation (web)
- **Steps:** As the buyer, open the paid order at `/account/orders/<n>` → click **Request cancellation** → optionally type a reason → **Submit request**.
- **Expected:** The button is replaced by "Cancellation requested". An alert email lands at `notify@fusionprints.co.zw` ("🟠 Cancellation requested"). The request shows in the admin order modal.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### CR-02 — Request button only shows when eligible
- **Expected:** "Request cancellation" appears only for paid orders not yet printed/ready/fulfilled. It's absent on unpaid, already-printed, fulfilled, or cancelled orders (and once a request is pending).
- **Result:** ☐ PASS ☐ FAIL — Notes:

### REF-01 — Admin approves → real Payonify refund ⚠️ (live-money check)
- **Steps:** Admin → open the order modal → the amber "Cancellation requested" banner shows → click **Approve & refund** → confirm.
- **Expected:** Success alert "Refund issued". Order flips to **Cancelled**, modal shows "Refunded $X". In **Payonify** the charge shows a matching refund. In **QuickBooks** a Refund Receipt (`REF-<order>`) is posted. Customer gets the refund email (and WhatsApp if a bot order). Any queued/awaiting print + slip jobs are now failed (not dispatched).
- **Result:** ☐ PASS ☐ FAIL — Notes (record the Payonify refund id):

### REF-02 — Refund failure leaves the order intact
- **Steps:** Force a failure (e.g. temporarily wrong Payonify key on staging, or an order with no charge reference) → Approve & refund.
- **Expected:** Red "Refund failed" banner, order is **not** cancelled, a **Retry refund** button appears. No QBO receipt, no customer "refunded" message.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### CR-03 — Admin declines a request
- **Steps:** With a pending request, click **Decline request** → confirm.
- **Expected:** Order stays live (status unchanged), request clears. Customer sees "Cancellation declined" on their order page and gets the declined email/WhatsApp.
- **Result:** ☐ PASS ☐ FAIL — Notes:

### REF-03 — Admin direct cancel of a paid order refunds too
- **Steps:** On a paid order with no customer request, click **Cancel order**.
- **Expected:** Same as REF-01 (Payonify refund + QBO + notify + jobs stopped) — the alert confirms "cancelled and refunded".
- **Result:** ☐ PASS ☐ FAIL — Notes:

### REF-04 — Idempotency / no double refund
- **Steps:** After a successful refund, try Approve/Cancel again (or replay).
- **Expected:** No second Payonify refund is issued; the order stays cancelled/refunded.
- **Result:** ☐ PASS ☐ FAIL — Notes:

---

## 5. Defect log

| # | Channel | Case ID | What happened | Severity | Status |
|---|---------|---------|---------------|----------|--------|
| 1 |         |         |               |          |        |
| 2 |         |         |               |          |        |
| 3 |         |         |               |          |        |
| 4 |         |         |               |          |        |
| 5 |         |         |               |          |        |

_Severity: blocker / major / minor / cosmetic._
