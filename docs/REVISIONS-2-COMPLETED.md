# FusionPrints — Revisions 2 (FP_rev2): Completion Record

Implementation log for the second findings round (`docs/REVISIONS-PLAN-2.md`).
Built & shipped 2026-06-21. **All 17 findings complete** — backend deployed to
prod (`api.fusionprints.co.zw`), web deployed on Vercel (`app.fusionprints.co.zw`).

Repos: **be** = `fusionprints` (Node/Fastify/Drizzle), **web** = `fusionprints-web`
(Next.js). Backend deploys via `npm run deploy`; web deploys are manual (Vercel).

Hosting map: `fusionprints.co.zw` = static marketing · `app.fusionprints.co.zw`
= Next.js app · `api.fusionprints.co.zw` = backend.

---

## 1. Findings — what was built

### R2-1 — Customer emails from "FusionPrints Lab" (#22) · be · PR #30
Changed the `from:` display name on all **customer-facing** emails to
`FusionPrints Lab <noreply@fusionprints.co.zw>` — order receipts + the brand
email shell (`web-order-email.ts`) and the signup/verify email (`web/auth.ts`).
Internal operator-alert emails (`operator-email.ts`) keep "FusionPrints".

### R2-2 — Receipt flow: resend button, filename, fire-on-paid (#9,#12,#13,#14) · be · PR #30
- Admin order action renamed **"📄 Receipt" → "🔁 Resend receipt"**; it now
  re-sends the **branded** receipt to **both channels** the order has via a new
  `resendReceipt(orderId)` (`services/admin-ops.ts`) + `POST
  /admin/api/ops/orders/:id/resend-receipt`. Email is forced past the once-only
  guard (`sendOrderReceipt(orderNumber, { force })`); WhatsApp PDF self-guards.
- Receipt **filename = order number** (`FP-2026-0010.pdf`) — `receiptPdfFilename`,
  applied to the email attachment + the WhatsApp document.
- Receipts already fire automatically **on payment** (the QBO pipeline, R2-2b),
  satisfying "send as soon as marked paid" (#13).

### R2-2b — QBO invoice → payment → branded PDF receipts (+ void-on-abandon) · be · PR #26 · migration 0032
Replaced the hand-rolled SVG receipt with **QBO-rendered PDFs** and moved to an
**Invoice → Payment** model:
- Order create → **QBO Invoice** (`orders.qbo_invoice_id`, idempotent by
  DocNumber). Paid → **Payment** against it (→ "PAID"); no double-counting.
- Abandoned/cancelled (unpaid) checkout → **void the invoice** automatically
  (wired into the hourly `expireStalePendingOrders` sweep + `cancelOrder`).
- `renderReceiptPdfBytes` prefers the QBO PDF (branded via the company's QBO
  Custom Form Style), falling back to the SVG only when QBO is off/unreachable.
- New `qbo.ts` ops: `qboRequestPdf`/`fetchTxnPdf`, `createInvoice`, `findInvoice`,
  `recordInvoicePayment`, `voidInvoice`. `markOrderPaid` awaits the payment post
  so the PDF reads PAID before receipts are fetched.
- **Founder one-time action (done):** branded the QBO **Standard** form style —
  the API render only ever uses Standard, not a "default"-flagged custom style.

### R2-3 — Branded payment method on receipt (#11) · subsumed by R2-2b
The QBO-rendered invoice/receipt shows the payment + is fully branded via the
QBO Custom Form Style. Specific EcoCash/Visa/Mastercard logos are a QBO-template
nicety configurable there; no separate renderer work needed.

### R2-4 — Fulfilment & ready notifications + delivery template (#4,#6,#7) · be · PR #31
- **Ready-for-pickup** and **out-for-delivery** now also send a **branded email**
  (`sendOrderReadyEmail`) — reaches web/non-WhatsApp customers with no number.
- Marking an order **fulfilled** fires a **thank-you on WhatsApp + email**
  (`notifyOrderFulfilled` + `MSG.orderFulfilled` + `sendOrderFulfilledEmail`),
  wired into the admin `/fulfil` endpoint.
- **Delivery** got its own email template (mirrors pickup). All best-effort.

### R2-5 — Web order-tracking status banners (#23,#24) · web · #9
The order page banner is now status-aware: **cancelled** (refund note, coral),
**ready-for-pickup/collection** + **out-for-delivery** (ready note), **fulfilled**
(delivered/collected thank-you) — overriding the just-placed message.

### R2-6 — WhatsApp email capture: Skip button + re-ask (#10,#20) · be · PR #34 · migration 0033
- The email ask is now an interactive message with a **"⏭️ Skip" button**
  (id `SKIP`, handled same as typing "skip"). Typing an email still works.
- Returning customers with no email are asked **each order** (they were never
  re-asked) — until they've **declined 3 times**, then we stop.
  Tracked via `customers.email_decline_count`.

### R2-7 — Refund message on WhatsApp (#21) · be · (already wired, PR-12)
Confirmed: `refund.ts` → `notifyCustomerOfCancellation(orderNumber, 'refunded')`
sends the WhatsApp `refundIssued` message at refund approval. No change needed.

### R2-8 — Poster/canvas approval → notify admin (#5) · be · PR #33
When an order enters `awaiting_approval`, email ops (`sendApprovalNeededAlert`
→ `OPERATOR_ALERT_EMAIL`) so it doesn't sit unapproved holding its prints/slips.
The dashboard already badges the pending count.

### R2-9 — Media-switch alert (#8) · be · PR #33
A 5-min sweep (`checkMediaSwitchNeeded`) detects dye-sub jobs **queued for media
the DNP isn't loaded with** (e.g. left on 5×7 while 4×6 orders pile up); once any
has waited >10 min it emails ops (`sendMediaSwitchAlert`). Cooldown-guarded:
one alert per backlog, re-arms when it clears.

### R2-10 — Cancelled-orders audit tab + metric (#25) · be · PR #32
Cancelled orders fell through both the Active and Completed lists (vanished).
Added a **"Cancelled" tab** to Order Management (`getCancelledOrdersList` — date,
order #, name, total, refund status, fulfilment) + a **"Cancelled orders"**
metric card (count + value over the period).

### R2-11 — Collection-point Navigate link (#15) · be · PR #35 · migration 0034
Admin-editable **Google Maps link** per collection point
(`collection_points.maps_url`, a field on the Locations admin form). When set,
the customer's ready-to-collect notifications include a **Navigate** action: a
"🧭 Navigate to collect" button in the pickup email + a "🧭 Navigate: <url>" line
in the WhatsApp ready message.

### R2-12 — WhatsApp order history + cancel (#16) · be · PR #36
Order history already existed (the bot **STATUS** command). Added a
**`CANCEL <order#>`** command (e.g. `CANCEL FP-2026-0010`): verifies the order
belongs to the customer, then cancels outright if unpaid (voiding any QBO
invoice) or files a **cancellation request** for admin review if paid (→ approve
→ Payonify refund, reusing PR-12). The status list shows a how-to-cancel hint.

### R2-13 — Order on behalf of someone (#17) · be + web · PRs #37, #38, web #11 · migrations 0035, 0036
**Stage 1 (bot, PR #37, migration 0035):** after the fulfilment choice the bot
asks "is this for someone else?" (Skip button) at the single convergence point
(`buildOrderSummary`, once-only flag) → captures `orders.recipient_phone`. New
`collecting_recipient` step. **Notify-both:** ready-for-pickup / out-for-delivery
/ fulfilled now message **both the buyer and the recipient**
(`recipientPhones()` helper, deduped, best-effort).
**Stage 2 backend (PR #38, migration 0036):** `/web/api/checkout` accepts
optional `recipientName`, `recipientPhone` (→ E.164), `billingAddress`;
`createWebOrder` persists them (`orders.billing_address`).
**Stage 2 web form (web #11):** checkout adds a **"gift / for someone else"**
toggle (recipient name + WhatsApp number, validated) and a **"billing address is
different"** toggle (free-text); both sent only when provided.
**Note:** `billing_address` is stored for records; its **card-AVS use stays
gated** on the blocked Payonify vaulting (PR-13).

### R2-14 — Signup email-confirmation 404 (#1) · be · PR #31
The verification email linked to `/auth/verify`, but the Next.js page is at
**`/verify`** (the `(auth)` route group adds no path segment) → it 404'd and
blocked account activation. Pointed the email at `/verify`.

### R2-15 — Upload progress for Google Photos + device (#2) · web · #10
The editor already showed byte progress for **device** uploads; **Google Photos**
imports never appeared in the panel. Wired Google Photos in as an
**indeterminate** progress row ("Importing…", animated, resolves to done/error) —
the backend poll reports no byte progress, so indeterminate is accurate.

### R2-16 — Mini prints discoverable in the editor (#3) · web · #10
Composites (Wallet/Mini/Passport) are a separate flow (`/prints/{slug}`) and
weren't surfaced in the single-photo editor. Added a **"Photo sets"** section
linking to the three composite pages, in both the desktop product picker and the
mobile size-picker modal. (No forcing the 2-photo composite flow into the editor.)

### R2-17 — Privacy policy: card-data handling (#18,#19) · web · #10
Added a **"Card payments"** section to the privacy page: FusionPrints never
collects or stores raw card details — payments go entirely through Payonify
(PCI-compliant); we only receive a tokenised reference + confirmation. (#18
"card payments on WhatsApp" ties to the blocked Payonify vaulting; the privacy
copy is accurate to the gateway-handles-it position.)

---

## 2. Database migrations (this round)

| # | Migration | Change |
|---|-----------|--------|
| 0032 | `qbo_invoice_id` | `orders.qbo_invoice_id` (R2-2b) |
| 0033 | `email_decline_count` | `customers.email_decline_count` (R2-6) |
| 0034 | `collection_point_maps_url` | `collection_points.maps_url` (R2-11) |
| 0035 | `order_recipient` | `orders.recipient_name` + `recipient_phone` (R2-13) |
| 0036 | `order_billing_address` | `orders.billing_address` (R2-13 Stage 2) |

---

## 3. Bugs surfaced during e2e testing (fixed this round, not rev2 findings)

| PR | Fix |
|----|-----|
| #24 | **Refund charge-id capture** — web refunds used the `cs_` checkout-session id; the refundable `ch_` is the session's `transaction_reference`. Also scoped the Payonify webhook to `checkout.*`/`charge.*` so refund events don't re-run fulfilment. |
| #25 | **Stale settled-order in bot context** — a returning WhatsApp customer was told "you have an order in progress" for a fulfilled order; the bot now clears `context.orderNumber` once an order is past `pending_payment`. |
| #27 | **Poster approval gate** — a slip starting flipped the order to `printing` (hiding the Approve button); and poster-only orders now hold ALL slips (incl. promo) until approval. |
| #28 | **WhatsApp receipt delivery** — the in-chat PDF used a private B2 URL (360dialog got HTTP 401, silently dropped). Now a presigned URL. |
| #29 | **Payment-failure UX** — a failed/slow EcoCash charge left the customer stuck on "Sending payment request"; now a WhatsApp message with **[🔄 Try again] [❌ Cancel order]** buttons. |

---

## 4. Residual / blocked / launch toggles

- **PR-13 Payonify vaulting** — still blocked. Gates *saved cards* and the
  *card-AVS use* of the billing address captured in R2-13 (capture/storage done).
- **Launch toggles** before go-live: `VIRTUAL_PRINTERS=true` → off (so real jobs
  wait for the Beelink agent); Payonify `pk_test` → `pk_live`.

---

## 5. PR index

**be (`fusionprints`):** #26 (R2-2b), #30 (R2-1, R2-2), #31 (R2-14, R2-4),
#32 (R2-10), #33 (R2-8, R2-9), #34 (R2-6), #35 (R2-11), #36 (R2-12),
#37 (R2-13 S1), #38 (R2-13 S2 backend) — plus testing fixes #24, #25, #27, #28, #29.

**web (`fusionprints-web`):** #9 (R2-5), #10 (R2-15, R2-16, R2-17), #11 (R2-13 S2 form).
