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

---

## 2. The five card types

| Type | Printer | Rotates? | Content |
|------|---------|----------|---------|
| `end_separator` | dye_sub_4x6 | design rotates over time | "Hold the moment." brand moment + thank-you + WhatsApp help line |
| `order_info` | dye_sub_4x6 | design rotates over time | Order #, customer, items, paid/method, (QR to admin — see open Q) |
| `promo` (slot 1) | dye_sub_4x6 | **content is campaign-driven** | Launch: referral card. Later: a campaign upsell |
| `promo` (slot 2) | dye_sub_4x6 | **content is campaign-driven** | Launch: upsell with product-image frames. Later: a second upsell |
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

### Referral (live system — decided 2026-06-05)
Real per-customer codes, not static copy:
- A unique referral code per customer (web user; WA customer where applicable).
- Redemption tracking (who referred whom, reward state) so "you both get a free
  5×7" can actually be honoured.
- Code is rendered onto the referral card and echoed via WhatsApp.

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
| Promo renderers | none | referral + upsell (upsell composites campaign images) |
| Campaign management | none | admin CRUD: active campaign + slot defs + images |
| Referral system | none | codes + redemption tracking + surfacing |
| Thermal label | ZPL generator built | unchanged; **hardware not yet** — verify ZPL logically |

---

## 6. Implementation plan (phased, each independently shippable)

1. **Schema migration** — add promo enum value(s), `template_version` (+ campaign
   reference) on `slip_jobs`; new `promo_campaigns` table; referral tables
   (`referral_codes`, `referral_redemptions`).
2. **Queue promos** in `order.ts` at payment: promo 1 (seq 60) + promo 2 (seq 70)
   from the active campaign, each in its own try/catch so a slip failure never
   blocks customer prints. Idempotent with `markOrderPaid`.
3. **Promo renderers** — `renderAndUploadPromoReferral`, `renderAndUploadPromoUpsell`
   (SVG → PNG → B2, reusing the existing pipeline; upsell pulls campaign image
   keys into the frames).
4. **Campaign layer** — `promo_campaigns` + a minimal admin screen to set the
   active campaign and its images; renderers read the active campaign.
5. **Referral subsystem** — code generation per customer, redemption tracking,
   surfacing on the card + WhatsApp.
6. **Thermal** — already built; verify ZPL via a logical viewer (labelary.com)
   until hardware arrives.
7. **Design pass** — regenerate/improve the card designs with Gemini/creative;
   store campaign product images in B2.

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

## 7. Open / minor decisions
- **QR on `order_info`:** mockup shows a "scan to view in admin" QR; the
  production SVG dropped it. Keep it or not?
- **Campaign image storage:** confirm B2 folder + naming for Slip-2 product
  images selected in admin.

---

## 8. Cost (per order)
End separator + order info + 2 promos (4 × $0.10 dye-sub) + thermal label
($0.02) ≈ **$0.42/order**. At 150 orders/month ≈ **$63/month** for the full
slip + label system (up from $0.22 when only 2 cards printed).
