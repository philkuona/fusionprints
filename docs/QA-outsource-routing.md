# QA Guide — Fulfillment Routing & Outsourcing

**Feature:** outsourced fulfillment for large/wall sizes (8×10, 11×14, 12×18, 16×20) via an invisible partner print shop, with auto-dispatch on payment, dual-stream order status, and admin overrides.
**Audience:** Philip / Tobias (manual walkthrough — tick each case, note defects at the bottom).
**Build:** Outsource Routing Phases 1–7 (PRs #49–#54). See `docs/OUTSOURCE-ROUTING-PLAN.md`.

> How to use: work top to bottom. Each case has **Do** / **Expect**. Mark **Pass / Fail** and jot anything odd in the Defect log. Customer-facing checks are about what a customer would see; the rest are admin (`/admin`).

---

## 0. Prerequisites (do these first)

| # | Do | Expect |
|---|----|--------|
| 0.1 | Deploy backend; run `npm run db:migrate`. | Migrations **0038–0041** apply with no error. |
| 0.2 | Confirm the admin nav shows a **Partners** tab (full-admin login). | "Partners" appears between Locations and QuickBooks. |
| 0.3 | Open `/admin/printers`. | **Only the DNP DS620A** is listed — no Epson / inkjet row. |
| 0.4 | Decide test vs live: for a dry run keep `VIRTUAL_PRINTERS=true` and Payonify **test** keys; for go-live flip `VIRTUAL_PRINTERS=false` + Payonify live keys. | (Noted — affects whether prints/payments are real.) |

> Note: the print agent (DNP) is in Zimbabwe; if it's offline, in-house jobs queue and wait — that's expected and doesn't affect outsource dispatch (which is email).

---

## 1. Partner setup (`/admin/partners`)

| # | Do | Expect |
|---|----|--------|
| 1.1 | With **no** partner yet, place + pay a test order containing an 8×10 (see §3 for how). | Order is paid; an **ops alert email** arrives: "Outsource dispatch failed … No active default partner". The in-house part is unaffected. (Confirms nothing silently drops.) |
| 1.2 | Add a partner: name, short code, **your own email** as contact email, preferred channel **Email**, tick all four supported sizes, set a wholesale price per size, tick **Active** + **Default**. Save. | Partner appears with **Default** + **Active** badges. |
| 1.3 | Add a second partner, tick **Default** on it, save. | The second is now Default; the first is no longer Default (only one default at a time). |
| 1.4 | Edit a partner; change a wholesale price; save. | Change persists on reload. |
| 1.5 | Deactivate a partner. | It shows **Inactive**, loses Default, and is not used for new dispatches. |
| 1.6 | Leave exactly one **active default** partner with a valid email for the rest of the guide. | Ready to dispatch. |

---

## 2. Customer experience is unchanged (the partner is invisible)

| # | Do | Expect |
|---|----|--------|
| 2.1 | On the web store, browse the wall-art / large sizes as a customer. | Normal product pages. **No** mention of "outsource", "partner", "third party", or split fulfilment anywhere. |
| 2.2 | Upload a **low-resolution** photo and pick a large size (e.g. 16×20). | A warning appears (size picker flags it; crop modal says "Resolution too low…"). |
| 2.3 | Try to proceed past the low-res warning. | You **can** proceed via **"Print anyway"** — it warns but never blocks. |
| 2.4 | Place an order and track it on the order page (and WhatsApp if used). | Status reads as a single simple progression (Received → Printing → Ready → …). **No** outsource/partner wording. |

---

## 3. Auto-dispatch on payment (the core flow)

> "Place + pay" = add item(s) to cart, check out, complete payment (test card/EcoCash in test mode).

| # | Do | Expect |
|---|----|--------|
| 3.1 | **In-house only:** order some 4×6 / 6×8 prints; pay. | Order goes through the normal in-house flow. In the admin order modal there is **no** "Outsource" section. |
| 3.2 | **Outsource only:** order a single 11×14; pay. | Within ~a minute, the **partner email** (your address from 1.2) receives a message with a **ZIP** attached. |
| 3.3 | Open the ZIP. | Contains: a **print-ready JPEG** (named `FP-…_…_11x14_lustre_x1.jpg`), a **spec PDF**, and a **spec JSON**. |
| 3.4 | Open the JPEG; check properties. | Full print size for 11×14 at ~300 DPI, crop baked in, looks correct. (Colour profile is sRGB — embedded.) |
| 3.5 | Open the spec PDF + JSON. | Shows order ref, size, finish, qty, instructions. **No customer name, phone, or price** anywhere. |
| 3.6 | **Mixed:** order one 6×8 (in-house) + one 12×18 (outsource); pay. | In-house 6×8 enters the print queue; the 12×18 is emailed to the partner. The admin modal shows **both** an in-house print job and an Outsource section. |
| 3.7 | Re-trigger the same paid order's webhook (or just observe — don't pay twice). | The order is **not** dispatched twice (idempotent). |

---

## 4. Admin order view + manual overrides

Open an order with outsourced items in `/admin` → click the order.

| # | Do | Expect |
|---|----|--------|
| 4.1 | Look at the **Outsource — wall prints** section. | Shows stream status (e.g. "Dispatched"), and a dispatch row: partner, channel, timestamp. |
| 4.2 | Click **Re-send**. | A fresh email/ZIP arrives at the partner; a new dispatch row is logged. |
| 4.3 | Use the partner dropdown + **Send to selected** (pick a different active partner). | That partner receives the package; dispatch row shows the new partner. |
| 4.4 | Click **Mark received** (simulating the prints coming back). | Status becomes **Received**. |
| 4.5 | On a different order, click **Mark manually fulfilled**. | Status becomes **Received** with a "manually fulfilled" dispatch row. |

---

## 5. Dual-stream rollup to "Ready"

| # | Do | Expect |
|---|----|--------|
| 5.1 | Mixed order (§3.6): let the in-house 6×8 finish printing (or in virtual mode it auto-completes), but **do not** mark the outsource received yet. | Order does **not** advance to "Printed/Ready" — it waits on the outsource stream. |
| 5.2 | Now **Mark received** on the outsource section. | Order advances to **Printed** (ready to release). Release for pickup / mark out for delivery as normal. |
| 5.3 | Outsource-only order (§3.2): finish its slips, then **Mark received**. | Order advances to **Printed** only after received (slips alone don't complete it). |
| 5.4 | In-house-only order (§3.1). | Advances to Printed when its jobs finish — outsource never gates it (no regression). |

---

## 6. Failure handling

| # | Do | Expect |
|---|----|--------|
| 6.1 | Set the default partner's contact email to an obviously bad address; place + pay an outsource order. | Dispatch retries then fails; an **ops alert email** arrives; the order's Outsource status shows **Failed** with the error. |
| 6.2 | On that failed order, fix the partner email, then click **Re-send**. | Dispatch succeeds; status flips to Dispatched. |
| 6.3 | Deactivate all partners; place + pay an outsource order. | Dispatch fails with "No active default partner" + ops alert; in-house part (if any) unaffected. |
| 6.4 | Pay an outsource order, then cancel/refund it **before** marking received. | The order cancels/refunds normally; outsource cost is only what was recorded at dispatch. |

---

## 7. Cost accounting (margin)

| # | Do | Expect |
|---|----|--------|
| 7.1 | After a few dispatched outsource orders, check the dispatch rows (admin order modal). | Each dispatched row carries a **wholesale cost** = the partner's price × qty at dispatch time. |
| 7.2 | (If checking books) Note: QBO posts **revenue only** for now; outsource COGS journal posting is a **planned phase 2** — the cost is captured in the DB but not yet pushed to QuickBooks. | No COGS entry in QBO yet (expected). |

---

## 8. Epson retirement sanity

| # | Do | Expect |
|---|----|--------|
| 8.1 | `/admin/printers`. | No Epson / inkjet printer. |
| 8.2 | Place an 8×10 (formerly an Epson size). | It is treated as **outsourced** (emailed to partner), **not** sent to any in-house printer queue. |

---

## Defect log

| Case # | What happened | Severity | Notes / fix |
|--------|---------------|----------|-------------|
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

---

### Reminders before real customers
- `VIRTUAL_PRINTERS=false`
- Payonify **live** keys (currently test)
- One **active default partner** with a real, monitored email + agreed wholesale prices
- Migrations 0038–0041 applied on prod
