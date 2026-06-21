# FusionPrints — Revisions Plan 2 (FP_rev2.docx)

Second round of findings, captured 2026-06-20 from end-to-end testing on prod.
Audited against current code. Two repos: **be** = `fusionprints` (backend),
**web** = `fusionprints-web`, **agent** = `fusionprints-agent` (Beelink).

Legend: ✅ done · 🟡 partial · ⬜ not started · 🔬 needs external confirmation · ❓ needs your decision

---

## 1. Audit by finding

| # | Area | Finding | State | Notes (evidence / approach) |
|---|------|---------|-------|------------------------------|
| 1 | Sign up | Email confirmation link shows a 404 ("This page hasn't been printed yet…"). | ⬜🔬 | Confirmation link likely points at a route that 404s (token route mismatch, or web vs be origin). Reproduce with a real signup, trace the link target. **Blocks new web signups.** |
| 2 | Upload | Show upload progress for Google Photos **and** device uploads. | ⬜ | Editor upload has no per-file progress UI. Add progress (bytes / count) for both sources. web. |
| 3 | Editor | Mini prints not showing in editor — only Prints + wall art visible. | ⬜ | Composite/mini product missing from the editor product list. Likely a catalog/category filter gap. web. |
| 4 | Printing | "Ready for delivery/pickup" should also email customers **not** on WhatsApp. | 🟡 | Status transition to `ready_for_collection` exists; wire an email for web/non-WA customers. be. |
| 5 | Printing | Poster order should notify admin for approval (same path will serve canvas later — media change). | 🟡 | Posters already set `awaiting_approval` (PR-22), but no **admin notification** fires. Add admin alert (email + dashboard badge). be. |
| 6 | Printing | Marking an order **fulfilled** (picked up/delivered) should fire a thank-you — WhatsApp **and** email. Needs template. | ⬜ | `/admin/api/orders/:id/fulfil` exists (admin-dashboard.ts:452) but sends nothing. Add thank-you template + dual-channel send. be. |
| 7 | Printing | No **delivery** template yet — draft one mirroring pickup. | ⬜ | Pickup/collection copy exists; add the delivery equivalent across email + WA. be. |
| 8 | Printing | If operator forgot to switch media and a job needing 6×8 media is waiting, fire an alert to switch. | 🟡 | Extends the existing media guard + 5×7 operator gate. Detect "waiting job needs media X but current media ≠ X" → alert. Ties to [[founder-pending-actions]] alert env vars. be. |
| 9 | Receipts | Web order did **not** send a PDF receipt. | 🟡🔬 | Attachment code added (web-order-email.ts:164) but user's web test had no PDF. Reproduce: `renderReceiptPdfBytes` may have returned null for that order, or the email path differed. **Verify on prod.** be. |
| 10 | Receipts | WhatsApp email-ask should offer **SKIP** as a button, not typed text. | ⬜ | `askEmail` (messages.ts:275) is text-only. Add an interactive SKIP button. be. |
| 11 | Receipts | PDF receipt should show the **payment method**, branded — EcoCash logo / VISA·Mastercard. | ⬜ | Add a payment-method row + logo asset to the receipt SVG (receipt-pdf.ts `buildReceiptSvg`). be. |
| 12 | Receipts | Receipt **filename** should be just the order number. | ⬜ | `receiptPdfFilename` returns `FusionPrints Receipt FP-….pdf` → change to `FP-….pdf`. be. Trivial. |
| 13 | Receipts | WhatsApp/email receipt fires when operator clicks "Receipts" — **wrong**. Should send the moment the order is marked **paid**. | 🟡 | In-chat receipt already fires on paid; an operator-triggered send also exists. Make paid the single trigger; demote the button to resend (see #14). be. |
| 14 | Receipts | Rename admin **"Receipts"** button → **"Resend Receipt"**; resends to email **and** WhatsApp if the order has either. | ⬜ | Couples with #13 — the button becomes an explicit resend, not the primary path. be. |
| 15 | Collection Point | Add a **"Navigate"** button → opens Google Maps with the collection-point pin pre-set. | ⬜ | Add coords (or a maps URL) to collection points; render a Navigate button on web order page (and receipt/bot). be schema + web. |
| 16 | Orders | WhatsApp orders have **no order history**; no way for a WA customer to cancel. | ⬜ | Add a bot "my orders" view + a WA cancellation request path (feeds the existing approve-cancellation flow, PR-12). be. |
| 17 | Orders | **On behalf of someone:** notify both recipient + customer when ready; billing address may differ from delivery. Wire flow to capture recipient name / delivery address. | ⬜❓ | Larger flow change across bot + web checkout + notifications + schema (recipient fields). be + web. |
| 18 | Orders | How are **card payments** handled on WhatsApp? | 🔬❓ | Investigate/decide. Card on WA needs a hosted pay link (no raw card in chat). Ties to PR-13 vaulting (blocked) + #19. |
| 19 | Payments | Confirm we never store raw card data (gateway handles it); update **privacy policy** to reflect. | 🟡🔬 | Payonify Drop-In keeps card data off our servers — confirm + document. Add/adjust privacy-policy copy. web (policy) + investigate. |
| 20 | Receipts | Returning WA customer not asked for email when they'd want a receipt. Ask each order w/ SKIP; stop after 3 declines. | ⬜ | Track decline count on the customer; prompt-with-SKIP until 3, then stop. Couples with #10. be. |
| 21 | Refunds | Refund messages should also fire on **WhatsApp** — needs template. | 🟡 | `refundIssued` template exists (messages.ts:339); confirm it actually sends on WA at refund approval and wire if not. be. |
| 22 | Email | Customer-facing emails should come from **"FusionPrints Lab"**, not "FusionPrints". | ⬜ | 5 `from:` sites; change customer-facing ones (web-order-email ×2, auth, refund/cancellation). Leave operator-email (internal). be. Quick. |
| 23 | Web banner | Cancelled order should change the "order placed / confirmation on its way" banner to reflect cancellation. | ⬜ | Order-tracking page banner is status-blind. Branch copy on `cancelled`. web. |
| 24 | Web banner | Banner should also change when picked up / delivered. | ⬜ | Same banner — add `fulfilled`/`ready` states. web. Couples with #23. |
| 25 | Cancelled Orders | Cancelled orders disappear from admin dashboard — audit must retain all transactions. Add a **cancelled tab** + metrics. | ⬜ | Dashboard query filters cancelled out. Add a Cancelled tab + cancellation metrics. be. |

---

## 2. Proposed PRs (rev2)

**Tier 1 — regressions / correctness, quick (do first):**
- **R2-1 Email sender → "FusionPrints Lab"** (#22, be) — change customer-facing `from` display names only (address unchanged). Trivial, high-visibility.
- **R2-2 Receipt flow fix** (#9, #12, #13, #14, be) — receipts fire on **paid** (single trigger); admin button → **"Resend Receipt"** (both channels); filename = order number; reproduce + fix the missing web PDF.
- **R2-14 Signup email-confirmation 404** (#1, be/web) — investigate + fix. Blocks signups.
- **R2-7 Refund message on WhatsApp** (#21, be) — confirm/wire `refundIssued` to send on WA at approval.

**Tier 2 — core-flow completeness:**
- **R2-4 Fulfilment & ready notifications** (#4, #6, #7, be) — ready-for-collection/delivery email for non-WA; fulfilled → thank-you (WA + email); delivery templates mirroring pickup.
- **R2-5 Web status banners** (#23, #24, web) — branch the tracking banner on cancelled / ready / fulfilled.
- **R2-6 WhatsApp email capture UX** (#10, #20, be) — SKIP button; ask returning customers each order; stop after 3 declines.
- **R2-8 Poster/canvas approval notification** (#5, be) — admin alert when an order lands in `awaiting_approval`.
- **R2-9 Media-switch alert** (#8, be) — alert when a waiting job needs media the printer isn't currently loaded with.
- **R2-10 Cancelled-orders audit** (#25, be) — retain cancelled in dashboard; add Cancelled tab + metrics.

**Tier 3 — enhancements:**
- **R2-3 Branded payment method on receipt** (#11, be) — payment-method row + EcoCash/Visa/Mastercard logos on the PDF.
- **R2-11 Collection-point Navigate button** (#15, be + web) — coords on collection point; Google Maps Navigate button.
- **R2-15 Upload progress** (#2, web) — per-file progress for Google Photos + device.
- **R2-16 Editor mini prints** (#3, web) — surface mini/composite prints in the editor product list.

**Tier 4 — larger / needs decisions:**
- **R2-12 WhatsApp order history + cancellation** (#16, be) — bot "my orders" + WA cancellation request.
- **R2-13 Order on behalf of someone** (#17, be + web) — recipient capture, billing≠delivery, notify both. ❓scope.
- **R2-17 Payments compliance + privacy policy** (#18, #19, web + investigate) — document card handling; update policy. Card-on-WA ties to PR-13 (blocked on Payonify vaulting).

---

## 3. Open questions / decisions needed
- **#17 on-behalf-of:** how much for launch — just "recipient name + delivery address" capture + notify both, or full billing-address + gifting flow? (drives R2-13 size)
- **#18 card on WhatsApp:** is card-in-chat in scope pre-launch, or EcoCash-only on WA for now (card stays web)? (PR-13 vaulting is blocked)
- **#11 logos:** confirm we can use EcoCash / Visa / Mastercard marks on receipts (brand usage).
- **#15 Navigate:** one collection point today — store a lat/lng or a full Google Maps share URL per point?

---

## 4. Notes
- Tier 1 + Tier 2 are the launch-blocking set (notifications, receipts, banners, audit). Tiers 3–4 are post-launch unless prioritised.
- Several items couple: #13+#14 (receipt trigger), #10+#20 (email capture), #23+#24 (banner), #5 reuses the canvas-approval path.
- WA card payments (#18) and saved cards (PR-13) share the Payonify-vaulting blocker.
