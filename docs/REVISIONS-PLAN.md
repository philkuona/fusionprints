# FusionPrints — Revisions Plan (FP_Revisions.docx)

Audit of each revision against what's currently on prod, with a proposed PR breakdown.
Generated 2026-06-19. Two repos: **be** = `fusionprints` (backend), **web** = `fusionprints-web`.

Legend: ✅ already addressed · 🟡 partial · ⬜ not addressed · 🔬 needs external confirmation · ❓ needs your decision

---

## 1. Audit by finding

| # | Finding | State | Notes (evidence) |
|---|---------|-------|------------------|
| 1 | WA not printing promo + order slips | ✅ mostly | Slips queued for all channels (`be order.ts:501 queueOrderSlips`) + served (`agent-api.ts:173`). **Promo slips only print if a campaign is `active`** (`order.ts:705`) — likely the cause. Held under 5×7 media mode. Needs a failing order # to confirm vs "no active campaign". |
| 2 | Upload-by-link doesn't ask qty (bot) | ⬜ | Link/batch paths fan each file to qty=1 and skip `choosing_quantity` (`be handler.ts:223,250`). Only single-photo asks copies. ❓ semantics. Ties to #18. |
| 3 | Finishes: Glossy + Lustre everywhere | 🟡 inconsistent | Editor offers **Glossy/Satin** (`web editor:1291`), product pages say **Glossy/lustre**, type defs disagree (`catalog.ts` glossy/lustre vs `payload-schema.ts` glossy/satin/lustre). Backend `paper` is free-text (no enum/pricing tie) → safe to standardize. ❓ copy. |
| 4 | WA EcoCash test failing | ✅ | Payment path complete + verified end-to-end (`be payment.ts`→`payonify-webhook.ts`→`markOrderPaid`). "Failing" = outbound WhatsApp blocked at 360dialog billing, not payment. |
| 5 | Branded receipts to customer | 🟡 | Web orders get a branded HTML email (`be web-order-email.ts`); **WhatsApp orders get only plain text** (`payment-webhooks.ts:42`). No PDF anywhere. ❓ format. |
| 6 | Order page "coming soon" | 🟡 | No order page literally says it. Most likely the **profile "Payment methods… available when checkout launches"** stub (`web profile:192`, stale). Also "coming soon" frame/mount badges. ❓ which. |
| 7 | Save payment methods (default) | ⬜ 🔬 | Per-order Drop-In only; no vault (`web payonify.ts`, `checkout/payment`). Needs Payonify tokenization + account UI. 🔬 confirm Payonify supports vaulting. |
| 8 | Cancellations → auto refund | ⬜ 🔬 | Cancel only flips status + posts **QBO refund receipt (accounting only)** — **no money moves** (`be admin-dashboard.ts:480,262`). No Payonify refund call exists. 🔬 confirm Payonify refund API (esp. EcoCash). ❓ approval gate. |
| 9 | Refunds — gateway handling | ⬜ 🔬 | Same as #8. |
| 10 | Marketing skill + email designs | ⬜ | All email is backend Resend. Net-new: a skill to design order-confirmation / update / refund / marketing emails. Research track. |
| 11 | Pickup name → "Fusion Prints Lab" | ⬜ | Currently "our studio" (web checkout:143) / `BUSINESS_NAME`/`BUSINESS_ADDRESS`/`BUSINESS_COLLECTION_ADDRESS` (be). Mostly config/strings. ❓ label-only or full rename. |
| 12 | Minimum order ($5 delivery) | ⬜ | No min-order logic anywhere. Cleanest chokepoint: `be pricing.ts calculateQuote` (covers bot + web). ❓ params. |
| 13 | Deleting My Photos breaks past-order previews | ⬜ | Hard delete (`web photos:163`→`DELETE /web/api/photos/:id`). Real risk: order previews may resolve to the source photo's B2 object. Fix is **backend data-lifecycle** (retain order render OR soft-delete/refcount). |
| 14 | Favicon | 🟡 | Branded `.ico` exists but no PNG/apple-touch/manifest icons or `icons` metadata (`web layout:28`). Add modern set + design skill. |
| 15 | Admin/operator UI redo (large fonts, brand buttons) | ⬜ | Server-rendered HTML strings with inline CSS across **7 route files (~2,600 LOC)**, no component reuse (`be admin-ops.ts` etc.). Big. ❓ scope. |
| 16 | Hide Total/amount column in operator mode | 🟡 | Detail modal gates it, but the **Completed-orders table shows Total unconditionally** (`be admin-ops.ts:625,636`). Quick fix. |
| 17 | No logout button | 🟡 | Route exists (`be admin-login.ts:244 /admin/logout`) but **not linked in the nav**. Quick fix. |
| 18 | Default to link, one upload button | ⬜ | Bot has 3 upload modes (`be state-machine.ts:649`); web editor has 3 entry points behind "Add photos" (`web editor:767`). Collapse to link/one button. Ties to #2. |
| 19 | Printer settings embedded in code | 🟡 🔬 | Backend job payload sends NO ICC/quality/media settings (`be agent-api.ts:378`) — those live in the **print agent** (separate Windows repo). |
| 20 | Switch-media mid 4×6 print | 🟡 | Media gate is serve-time only (`be agent-api.ts:120`); in-flight print completes, queued 4×6 held. **No "finish current queue before switching" guard.** Backend-only fix possible. |
| 21 | Printer settings editable in backend (admin) | ⬜ 🔬 | No printer-settings columns/UI; settings are agent-side. Net-new + needs agent protocol. |
| 22 | Best-quality/least-ink defaults embedded | ⬜ 🔬 | Net-new; needs the agent to apply ICC/quality. Backend can store, agent must consume. |
| 23 | Admin show ink levels + cost per job | ⬜ 🔬 | No ink field; heartbeat reports only status/media (`be agent-api.ts:601`, `schema printers`). 🔬 do DNP/Epson drivers expose ink + per-job cost to the agent? |
| 24 | Gaming centre (weekly free prints) | ⬜ | Net-new feature (web games + leaderboards + prize fulfilment). Research/design track. |
| 25 | 3D print add-ons | ⬜ | Net-new product line. Research track. |

---

## 2. Proposed PRs

**Tier 1 — quick, high-confidence (do now):**
- **PR-1 Operator dashboard fixes** (#16, #17, be) — hide Total column for operator in the Completed table; add a Logout link to desktop + mobile nav (route already works).
- **PR-2 Pickup location naming** (#11, be + web) — set "Fusion Prints Lab" via env (`BUSINESS_*`) + the "our studio" string. _Needs Q11._
- **PR-3 Stale "coming soon" copy** (#6, web) — fix the profile payment-methods stub (and frame/mount badges if wanted). _Needs Q6._
- **PR-9 Favicon/icon set** (#14, web) — add `icon.png`/`apple-icon.png` + `icons` metadata; design skill for a branded mark.

**Tier 2 — medium, scoped:**
- **PR-4 Finishes → Glossy + Lustre** (#3, web) — editor option Satin→Lustre, reconcile type defs, add best-use descriptions, fix stray Satin strings.
- **PR-5 Bot upload simplification + quantity** (#2, #18, be + web) — default the bot to the link upload, single "Upload photos" button; add a copies prompt for the single-photo case; consolidate web upload entry points. _Needs Q2/Q18._
- **PR-6 Minimum order** (#12, be) — `MIN_DELIVERY_USD` enforced in `calculateQuote` + bot/web messaging. _Needs Q12._
- **PR-7 Branded receipts** (#5, be) — reusable receipt template; send a branded email to WhatsApp customers who gave an email; keep plain-text as fallback. _Needs Q5._
- **PR-8 Media-switch guard** (#20, be) — block/warn the DNP toggle while a 4×6 job is `printing` (or queue incomplete).
- **PR-10 Photo-deletion lifecycle** (#13, be) — ensure order previews use a retained render, or soft-delete/refcount photos referenced by orders.

**Tier 3 — large / blocked on external confirmation:**
- **PR-11 Admin/operator UI redo** (#15, be) — centralize design tokens in `admin-fonts.ts`/`SHARED_STYLES`, bump type scale + brand buttons; per-file passes for promos/pricing/qbo/login. _Needs Q15 (scope)._
- **PR-12 Cancellations + auto-refund** (#8, #9, be) — Payonify refund API + persist charge id + approval gate + reconcile QBO. 🔬 _Blocked on Payonify refund capability._
- **PR-13 Saved payment methods** (#7, web + be) — Payonify vaulting + account UI + default. 🔬 _Blocked on Payonify vaulting._
- **PR-14 Printer metrics & settings** (#19, #21, #22, #23, be + agent) — ink levels, cost-per-job, embedded quality/ICC defaults. 🔬 _Blocked on print-agent/driver capability._

**Research track (spike before any PR):**
- Marketing/email-design skill (#10), Gaming centre (#24), 3D print add-ons (#25).

**Verification (not a PR):** #1 — capture a failing order # to confirm "promo slips not printing" = no active campaign vs a real bug.

---

## 3. Open questions (blocking)

- **Q3 (finishes):** Confirm drop **Satin → Lustre** for photo prints, and approve the best-use copy (Lustre = weddings/portraits/wall; Glossy = landscapes/travel/albums).
- **Q6 (coming soon):** Which page do you mean — the **profile "Payment methods… when checkout launches"** stub, or an actual order page?
- **Q11 (pickup name):** "Fusion Prints Lab" as the **collection-point label only** (keep brand "FusionPrints" in emails/logo), or a full rename?
- **Q12 (min order):** On **subtotal or total**? **Delivery only or all orders**? Pre- or post-discount? Hard block or just a notice?
- **Q5 (receipts):** Branded **HTML email** for both channels (cheapest, reuses Resend), or a **WhatsApp PDF** document for bot customers? Replace or supplement the plain-text confirmation?
- **Q2/Q18 (upload):** Keep "single photo, **many copies**" (needs the qty prompt) or collapse everything to **1 print per file**? Do composites stay on document upload?
- **Q15 (UI redo):** A **lightweight token refresh** (bump fonts/buttons in the shared styles — propagates cheaply) or a **full per-page rebuild** to brand guidelines? Is there a brand-guidelines reference for the admin UI?
- **External (🔬):** (a) Does **Payonify** support **refunds** (esp. EcoCash) and **card vaulting**? (b) Do the **DNP DS620A / Epson P5300** drivers expose **ink levels + per-job cost** to the agent? These gate PR-12/13/14.
- **Futuristic:** Priority/appetite for the marketing skill, gaming centre, and 3D add-ons — research spikes first?

---

## 4. Decisions (2026-06-19)

- **#3 Finishes:** drop **Satin → Lustre**. (PR-4)
- **#6 Coming soon:** the **profile page** payment-methods stub. (PR-3)
- **#11 Pickup name → bigger:** "Fusion Prints Lab" as the **collection label only**, PLUS a new requirement — **admin-managed collection points** (add/edit from Admin, auto-surfaced across bot + web). → PR-2 becomes a **feature** (new `collection_points` table + admin CRUD + bot/web read), not a string change.
- **#12 Minimums → bigger:** enforce an order **total** minimum to satisfy Payonify's minimum transaction amount: **pickup ≥ $2, delivery ≥ $5**, **admin-editable**. → PR-6 stores minimums in store-settings + admin UI; enforced in `calculateQuote`/checkout. Applies to total (what's charged).
- **#5 Receipts:** branded for **both channels** — see design proposal below. (PR-7)
- **#2/#18 Upload:** **one upload button → web link only**. Drop the bot's single/batch document modes. Quantity handled on the upload page (per-photo copies) so the chat stays simple. (PR-5)
- **#15 UI redo:** **full per-page rebuild** — current fonts unreadable at size, buttons need proper brand styling. (PR-11, large)
- **#8/#9 Refunds — UNBLOCKED:** Payonify has a refund API. Flow = **customer requests cancellation → admin approves → refund issued (Payonify) + QBO refund receipt**. Not automatic. (PR-12)
- **#23 Ink levels:** capability unconfirmed — needs checking on the print agent (see below).
- **#7 Saved cards:** still open — Payonify **vaulting** capability not yet confirmed. Parked.

### Branded receipt design (proposal)
One receipt renderer, three surfaces (single source of truth):
- **Template:** branded HTML (brand palette `#FBF7F0`/`#05D668`, Fraunces/Outfit, wordmark, order #, date, itemised lines, totals, fulfilment = collection point or delivery address, "Hold the moment" tagline, public order ref/QR).
- **Web orders:** keep the Resend email; upgrade it to the shared template + add a **"Download receipt"** (PDF) on the order page.
- **WhatsApp orders:** render the same template to a **PNG/PDF** (reuse the slip-renderer canvas pipeline) and send it as a WhatsApp **document** message; also email it if the customer gave an email. (Delivery currently blocked by the 360dialog billing issue, but the artifact is ready.)
- **Recommendation:** build the renderer once (HTML → image + PDF), reuse everywhere. Avoids divergent receipts.

### Printer ink levels (#23) — CONFIRMED (Epson only)
**Decision/fact (2026-06-19): Epson Status Monitor shows the Epson P5300 ink levels — so they're exposable. Only the Epson needs ink-level display. The DNP DS620A is dye-sub (no ink — uses ribbon/media).**
- **Epson P5300:** the print agent reads ink levels (Epson Status API / SNMP Printer-MIB if networked / Status Monitor data) and reports via heartbeat → backend stores a per-cartridge level field → admin shows it on the Epson card.
- **DNP DS620A:** no ink. Optionally show **prints/ribbon remaining** (DNP status), but not required.
- **Cost-per-job:** Epson via ink coverage; DNP via ribbon yield (ribbon cost ÷ prints-per-ribbon) — straightforward.
- **Net:** no longer blocked on capability — needs **print-agent** implementation (read Epson levels + report) + a small backend schema/display add.
