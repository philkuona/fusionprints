# Print Slip & Label System

Authoritative spec for the branded cards and envelope label produced with every
order. Supersedes the May-2026 build README (which only covered the first two
photo slips). Last updated 2026-06-05.

---

## 1. What prints with every order

Each paid order produces **two physical outputs**:

### A. The customer stack — 4 branded 4×6 cards + the customer's prints
All branded cards are **4×6 regardless of the customer's print sizes**, so they
always print on **DNP #1** (`dye_sub_4x6`, the 6×8-master printer). The DNP
outputs **face-up, so the last card printed lands on top of the stack.** Print
order (and resulting physical position) is:

| # | Card | `sequence_position` | Prints | Lands |
|---|------|---------------------|--------|-------|
| 1 | `end_separator` | 0 | first | **bottom** of stack |
| 2 | customer prints | 50 (implicit) | middle | middle |
| 3 | `promo` slot 1 | 60 | after prints | above customer prints |
| 4 | `promo` slot 2 | 70 | after prints | above promo 1 |
| 5 | `order_info` | 100 | last | **top** of stack |

So the customer opens the envelope to the order-info card on top and the
"Hold the moment." separator at the very back.

### B. The envelope label — 1 thermal sticker
A **2.25" × 4" precut direct-thermal label** (Zebra ZD411 / Xprinter XP-420B,
ZPL, 203 DPI = 457×812 dots) printed at the **start** of the order on the
thermal printer, hand-applied to the **outside** of the envelope. Big LASTNAME
for sorting the pickup bin without opening anything. This is independent of the
DNP stack (different printer), so its timing doesn't affect stack order.

### 2a. The "WhatsApp us" number (single source of truth) — required 2026-06-05
The `end_separator`'s help line ("Any issues? WhatsApp us …") must show the
**actual WhatsApp channel number customers message** — i.e. the number behind
the 360dialog account (`WHATSAPP_PHONE_NUMBER_ID`; its human-readable form
arrives on inbound webhooks as `metadata.display_phone_number`). It must **not**
be the customer's own phone, and must not drift from the live channel number.

Implementation note / known bug: the current WIP `slip-renderer.ts` renders
`data.customerPhone` on this line — that prints the *customer's* number. Fix:
source it from one config value that is the WhatsApp business number (set
`BUSINESS_PHONE` to exactly the 360dialog display number and use it for the slip,
the upload-page WhatsApp link, and anywhere else the business number appears), or
persist `display_phone_number` from the webhook and read that. One source, used
everywhere.

---

## 2. The five card types

| Type | Printer | Rotates? | Content |
|------|---------|----------|---------|
| `end_separator` | dye_sub_4x6 | design rotates; **always shows customer name** | "Hold the moment." + thank-you, {customer name}, + "WhatsApp us" help line = **the WhatsApp channel number** (see §2a) |
| `order_info` | dye_sub_4x6 | design rotates; **always shows customer name** | Order #, {customer name}, items, paid/method (no QR — customer-facing, dropped 2026-06-05) |
| `promo` (slot 1) | dye_sub_4x6 | campaign-driven | Launch: **static** referral card (not personalised). Later: a campaign upsell |
| `promo` (slot 2) | dye_sub_4x6 | campaign-driven | Launch: upsell with product-image frames. Later: a second upsell |
| `envelope_label` | thermal_label | rarely | LASTNAME, name, order #, paid/method, phone, items, FusionPrints HRE, timestamp |

The mockups (`slips-preview.html`, `slips-svg-preview.html`,
`thermal-label-preview.html`) are **prototypes to improve**, not final. The
Gemini / creative skills regenerate and refine the visual designs.

---

## 3. Promo system (decided 2026-06-05)

- **Two promo slots on every order**, both campaign-driven.
- **Launch campaign:** slot 1 = **referral**, slot 2 = **upsell**.
- **Later:** transitions to **two upsells** that change with new products /
  special occasions. The slot type is therefore not fixed — a campaign defines,
  per slot, the card type (referral | upsell) + its copy + its images.
- **Slot 2 (upsell)** has image frames filled with **product shots for whatever
  is being advertised** (the mockup Slip 3). Layout is fixed-ish; the images and
  copy come from the active campaign.
- **Control = admin-set campaign:** an admin screen selects the active campaign
  (the two slot definitions + uploads/selects the product images). No code edit
  per change.

### Referral (corrected 2026-06-05 — STATIC for launch)
At launch the referral card is **one-time / static** — a single shared design
(e.g. one launch code or a generic "share with a friend" CTA), the **same for
every order**. It is NOT personalised per customer at launch.

> The earlier "live per-customer referral codes + redemption tracking" decision
> is **deferred to post-launch**. It is no longer a launch deliverable, which
> removes the referral subsystem (codes/redemption tables) from launch scope.

Because it's static, the launch referral card is a **pre-rendered image reused
across orders** (same path as the upsell — see §3a), not a per-order render.

---

## 3a. Rendering architecture (decided 2026-06-05)

Design everything in **HTML** (with the ui-ux + Gemini skills); choose the
render path per card by whether it's personalised:

| Card | Personalised? | Render path |
|------|---------------|-------------|
| `order_info` | yes (name, items) | **per order**, SVG/Sharp (lean, no browser) |
| `end_separator` | yes (name; business WA number) | **per order**, SVG/Sharp |
| `promo` referral (launch) | no (static) | **once**, HTML→PNG, stored in B2 `campaigns/`, reused |
| `promo` upsell | no (per campaign) | **once per campaign**, HTML→PNG, stored in B2 `campaigns/`, reused |
| `envelope_label` | yes | ZPL string (no image) |

Consequence: **no headless browser runs in the order pipeline.** HTML→PNG only
happens at design/campaign time (can even be done by the skills offline and the
PNG uploaded). Recommended pattern when a card needs both rich design *and*
per-order data: HTML-designed **static background → PNG once → Sharp composites
the dynamic text** (name, etc.) per order. This also fixes brand-font fidelity
(today's SVG falls back to Georgia; bundled `@font-face` in HTML renders true
Fraunces/Outfit).

---

## 4. Sequencing model (already supported by the agent queue)

`slip_jobs.sequence_position` + `print_jobs.sequence_position` (default 50) drive
order. The agent's per-order job selection (in `routes/agent-api.ts`) serves one
order at a time: slips with seq < 50 before customer prints (`end_separator`),
then customer prints, then slips with seq ≥ 50 in sequence order, but only once
the order has no queued prints left. With promos at 60/70 and order_info at 100,
**the four-card flow works with no change to the queue logic** — only the new
slip rows + sequence numbers are needed.

> Foundation note: this relies on the per-order sequencing currently in progress
> in `routes/agent-api.ts` / `services/slip-renderer.ts`. The promo expansion
> sits on top of that being finalised.

---

## 5. Current state vs target

| Area | Today | Target |
|------|-------|--------|
| `slip_type` enum | `order_info`, `end_separator`, `envelope_label` | + `promo` (or `promo_referral` / `promo_upsell`) |
| Slips queued per order (`order.ts`) | 3 (separator, order_info, label) | 5 (+ promo 1 @60, promo 2 @70) |
| `slip_jobs` columns | no template/campaign ref | + `template_version`, + `campaign_id`/slot ref |
| Promo cards (launch) | none | 2 **static** PNGs (referral + upsell) in B2 `campaigns/`, reused per order |
| Campaign management | none | admin CRUD: active campaign + slot defs + images |
| Referral system | none | **deferred post-launch** (launch referral is a static card, no live codes) |
| `end_separator` WhatsApp number | renders `customerPhone` (WIP — wrong) | the WhatsApp channel number, single source of truth (§2a) |
| **Print agent slip consumption** | **NONE — agent has zero slip handling** | agent must process `slip` / `envelope_label` jobs, downloading by **B2 key** (bucket is private; the stored direct URL 401s — prints already download by key with the agent's own creds). Slip jobs/agent-api must expose the storage key. Affects ALL slips, not just promos. |
| Thermal label | ZPL generator built | unchanged; **hardware not yet** — verify ZPL logically |

---

### Launch scope (minimum to ship the 4-card stack)
1. **Schema migration** — add promo enum value(s), `template_version` + a campaign
   reference on `slip_jobs`; `promo_campaigns` table. *(No referral tables at
   launch — see deferred.)*
2. **Static promo PNGs** — design the referral + upsell cards in HTML, render to
   PNG (skills/offline or campaign-save), store under B2 `campaigns/`. No
   per-order render for promos at launch.
   - **Pipeline: ✅ proven** — HTML templates render to 4×6/300 DPI PNG via
     headless Edge (no backend browser). Templates: `docs/slip-templates/`.
   - **Creative: 🟡 PROVISIONAL / revisit before launch** — the current
     referral + upsell cards are TEST placeholders (copy/offer/images are
     stand-ins). Real launch creative + final offers to be produced when ready
     for launch. Referral redemption is **manual/honour-system** at launch (no
     referrer field on web yet; that's the deferred live-referral system).
3. **Queue promos** in `order.ts` at payment: promo 1 (seq 60) + promo 2 (seq 70),
   each pointing at the active campaign's PNG, each in its own try/catch so a slip
   failure never blocks customer prints. Idempotent with `markOrderPaid`.
4. **Fix the `end_separator` number** — render the WhatsApp **channel** number
   from the single source of truth (§2a), not `customerPhone`.
5. **Campaign layer** — `promo_campaigns` + a minimal admin screen to set the
   active campaign + upload its images.
6. **Thermal** — already built; verify ZPL via a logical viewer (labelary.com)
   until hardware arrives.
7. **Design pass** — regenerate/improve the card designs with Gemini/creative;
   store campaign product images in B2.

### Deferred (post-launch)
- **Live referral subsystem** — per-customer code generation, redemption
  tracking, surfacing on the card + WhatsApp, and personalised per-order
  rendering of the referral card. Not required for launch (launch referral is a
  single static card).

### Seamless-flow principles
- **Slips are best-effort, never blocking.** A render/queue failure logs + retries
  (`attempts` column) but never holds up the customer's prints.
- **Decouple content from design.** Campaign (what) + template_version (how it
  looks) are stored on each slip row → historical reproducibility when designs
  rotate.
- **One queue brain.** Don't special-case promos in the agent — they're just
  slips with sequence numbers; the existing per-order logic handles them.
- **Test without hardware.** Render PNGs and eyeball (like the preview HTMLs);
  validate ZPL logically before the printer exists.

---

## 7. Resolved decisions (2026-06-05)
- **No QR on `order_info`:** dropped — it's a customer-facing card, the
  scan-to-admin QR isn't needed.
- **Campaign images → B2 `campaigns/`:** admin-selected upsell product images
  are stored under a `campaigns/` prefix in B2 and referenced by the active
  campaign.

---

## 8. Cost (per order)
End separator + order info + 2 promos (4 × $0.10 dye-sub) + thermal label
($0.02) ≈ **$0.42/order**. At 150 orders/month ≈ **$63/month** for the full
slip + label system (up from $0.22 when only 2 cards printed).
