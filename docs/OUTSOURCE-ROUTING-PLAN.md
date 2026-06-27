# Fulfillment Routing & Outsourcing — Implementation Plan (v1)

**Status:** Awaiting sign-off
**Source brief:** `FusionPrints_FulfillmentRouting_BuildBrief.md` (Philip, June 2026)
**Author:** Claude Code · **Date:** 2026-06-27
**Scope:** Backend (`fusionprints`) + minor web (`fusionprints-web`)

---

## 1. Context & decisions locked

Launch equipment is **DNP DS620A only** (photo) + **Xprinter XP-420B** (thermal envelope label) + Beelink agent PC. Everything the DS620A can't print (8×10, 11×14, 12×18, 16×20) is **outsourced to a single partner print shop, invisibly to the customer**.

Decisions taken with Philip (2026-06-27):

| Decision | Choice |
|---|---|
| Passport composite | **Stays stubbed** (per-country sizing unresolved). Build around live products only. |
| Promo / slip system | **Unchanged** — promo + order-info + end-separator stay 4×6 dye-sub on the DNP; thermal stays the envelope label only. The brief's "promo slip on the XP-420B" was a conflation; no slip-system change. |
| QBO COGS | **Deferred to phase 2.** v1 records dispatch-time wholesale cost in the DB (margin reporting works); QBO journal posting is a follow-up. |
| First dispatch channel | **Email (ZIP)** — files + spec PDF + JSON. WhatsApp/portal deferred. |
| Partner routing | **Single active default partner** for all outsource sizes (brief's allowed v1 fallback). Per-size routing later. |

---

## 2. What already exists (reuse, don't rebuild)

- **Size→fulfillment field, half-built:** `config/catalog.ts:124` has a deprecated `isOutsourced: boolean` (always false). Promote to a real field.
- **Hard-coded routing to retire:** `services/order.ts:406` and `routes/agent-api.ts:712` both branch on `['8x10','11x14','12x18','16x20']` → `inkjet`/`dye_sub`. These arrays get deleted in favor of the catalog field.
- **Print-ready render already produced** (web orders): `services/edit-applier.ts:189` outputs **JPEG q92, 4:4:4, normalized sRGB, exact 300-DPI target res**, crop/rotate/border baked in, stored as `processedImages`. This is ~90% of the brief's "package."
- **Per-size resolution data:** `recommendedResolution` + `minResolution` on every catalog size — feeds the low-res warning with no new data.
- **Idempotent payment fan-out:** `markOrderPaid()` (`order.ts:537`) already calls `enqueuePrintJobsForOrder` + `queueOrderSlips` + 5×7 handling + QBO — the clean hook point for dispatch.
- **Delivery plumbing:** Resend email + B2 storage + signed URLs all in place.

## 3. Known gaps the plan must close

- **sRGB not necessarily *embedded*** — Sharp normalizes but doesn't tag an ICC profile by default. Brief requires embedded sRGB. → verify + `.withMetadata()`.
- **WhatsApp-sourced outsource items have no processed render** — they print from the raw upload. → render-on-demand at dispatch for those.
- **No per-stream order status** — single order status today; `printed` fires only when *all* jobs terminal (`agent-api.ts:548`). → add outsource stream + rollup gate.
- **QBO posts revenue only, no COGS** — entirely greenfield (deferred to phase 2).
- **Cost snapshotted at order time, never updated** — brief wants cost recorded *at dispatch*. → new dispatch-time cost capture.

---

## 4. Data model changes (migrations 0038+)

> Migration numbering continues from current tip **0037**. All additive; no destructive changes to existing columns.

**0038 — size classification**
- No DB change required if classification lives in the catalog config; but add a generated/derived column only if reporting needs it. **Plan: keep it in config** (`fulfillment` field) — no migration. (Listed here for ordering clarity.)

**0039 — outsource_partners**
```
outsource_partners(
  id uuid pk, name text, short_code text unique, active boolean default true,
  channels jsonb,                 -- [{type:'email'|'whatsapp'|'portal', value, label}]
  preferred_channel text,         -- which channel type auto-dispatch uses
  supported_sizes text[],         -- subset of outsourced size codes
  wholesale_prices jsonb,         -- { sizeCode: usd }
  turnaround jsonb null,          -- { sizeCode: '2-3 days' } (internal only)
  notes text null,
  is_default boolean default false,
  created_at, updated_at
)
```

**0040 — outsource_dispatches**
```
outsource_dispatches(
  id uuid pk, order_id uuid fk, partner_id uuid fk,
  channel text, status text,      -- 'pending'|'sent'|'failed'|'partner_confirmed'|'partner_ready'|'received_back'|'manually_fulfilled'
  line_item_ids uuid[],           -- order_items included
  package_url text null,          -- B2 key of the ZIP sent
  external_ref text null,         -- message id / email id if available
  wholesale_cost_usd numeric,     -- snapshotted AT DISPATCH
  error_message text null, attempts int default 0,
  created_at, sent_at null, updated_at
)
```

**0041 — order fulfillment streams**
- `orders.in_house_status text` (`not_applicable|queued|printing|printed|failed`)
- `orders.outsource_status text` (`not_applicable|pending|sent|partner_confirmed|partner_ready|received_back|failed`)
- (Overall `orders.status` stays the customer-facing rollup; these two are admin-only internal streams.)

No new `order_items` cost column needed — dispatch cost lives on `outsource_dispatches` (captured at dispatch, exactly per the brief).

---

## 5. Phased build (one PR each)

### Phase 1 — Size classification refactor *(no commercial inputs; foundational)* — ✅ DONE (branch `feat/outsource-phase1-size-classification`)
- Added `fulfillment: 'in_house' | 'outsource'` to `config/catalog.ts` (8×10/11×14/12×18/16×20 → `outsource`, all else → `in_house`) + `IN_HOUSE_PRODUCTS`/`OUTSOURCED_PRODUCTS`/`isOutsourcedProduct()`.
- Deleted the hard-coded size arrays in `order.ts:406` and `agent-api.ts:712`; routing now reads the field. `order.ts` now uses the previously-unused `getTargetPrinterType()` helper (identical output).
- New `tests/fulfillment-routing.test.ts` pins the classification + routing contract.
- **Two adjustments from the original plan (deliberate, to keep Phase 1 strictly behaviour-preserving):**
  1. **Kept the existing `isOutsourced` field** rather than replacing it. It turned out to gate *customer-facing* turnaround copy (the WhatsApp poster menu's "5–7 day turnaround" note), currently dormant (all `false`). Repurposing it would have silently published an unconfirmed turnaround SLA (open Q#3). `fulfillment` owns routing; `isOutsourced` stays the dormant copy flag until the turnaround wording is finalized (§6), then they fold together.
  2. **Did NOT skip outsource print-job creation.** Outsource items still create an inkjet job (which sits queued, exactly as today — no Epson agent claims it) so an outsource-only order does **not** silently auto-advance to "ready" with nothing produced. Job-skipping moves to **Phase 5**, where the dual-stream tracking + dispatch *replace* that print job.
- Public catalog API (`routes/web/catalog.ts`) already whitelists fields, so the new field is not leaked — no change needed.
- **Net effect: zero behaviour change.** Pure centralization of routing into one catalog field. Full suite green (127 tests).

### Phase 2 — Partner model + admin directory
- Migration 0039. New `services/outsource-partners.ts` (CRUD + `getDefaultPartner`).
- Admin page `/admin/partners` using `admin-theme.ts` shell + nav tab: add/edit/deactivate, set default, view dispatch history per partner.
- Full-admin only (not operator).

### Phase 3 — Print-ready package
- `services/outsource-package.ts`:
  - For web items: reuse `processedImages` render. For WhatsApp items: render-on-demand to target size via `edit-applier`/source image.
  - **Embed sRGB ICC** (`.withMetadata({ icc: 'srgb' })`) — verify output in a viewer.
  - Filename: `{orderRef}_{lineItemId}_{size}_{finish}_x{qty}.jpg`.
  - Spec **PDF** (reuse `pdf-lib` + SVG→PNG path from `receipt-pdf.ts`/`slip-renderer.ts`): order ref, size, finish, qty, paper, special instructions, delivery/pickup arrangement. **No customer name/phone/price.**
  - Spec **JSON** (machine-readable counterpart).
  - ZIP builder bundling images + PDF + JSON.
- Unit-testable without a partner.

### Phase 4 — Auto-dispatch + dispatch record *(needs partner email + wholesale prices)*
- Migration 0040. `services/outsource-dispatch.ts`.
- Hook into `markOrderPaid` after job/slip enqueue: if order has outsource items + active default partner supporting them + not already dispatched → build package (phase 3) → email via Resend → write `outsource_dispatches` row with **cost snapshot**.
- Retries: 1–2 with backoff, then `failed` + admin dashboard alert (reuse operator-email pattern).
- Guards: never dispatch if refunded/cancelled; idempotent on order id.
- Manual actions (admin): re-send, send-to-different-partner, mark-manually-fulfilled.

### Phase 5 — Dual-stream status + admin order view
- Migration 0041. Set `in_house_status`/`outsource_status` at `markOrderPaid` and as jobs/dispatches progress.
- **Rollup gate:** order may only advance to `printed`/Ready when **both** streams complete (extends `agent-api.ts:548` "all jobs done" logic to also require outsource stream done).
- Admin order modal (`admin-dashboard.ts` `getOrderDetails` + `admin-ops.ts`): new "Outsource" section — partner, channel, dispatch timestamp, status badge, re-send / send-other / mark-fulfilled buttons.
- **Customer-facing: no change** (already collapses to Received→Printing→Ready→Out for delivery→Delivered).

### Phase 6 — Low-res warning at order time *(needs per-size quality thresholds)*
- Surface existing `minResolution` in the web editor/checkout: warn when source < threshold for the chosen size. **Warn, never block.**

### Phase 7 — Retire Epson from active paths
- Remove `inkjet` from active routing/seed/printers page; keep git history (archive, don't delete).
- Schema enum: leave `inkjet` value in the pgEnum to avoid a destructive migration, but stop using it; document as retired. Remove Epson seed row + printers-page display.

**Dependency order:** 1 → 2 → 3 → (4 needs partner data) → 5 → 6 (needs thresholds) → 7. Phases 1, 2, 3, 7 need no commercial input and can land immediately.

---

## 6. Edge cases (from brief §"Edge cases") — handling

- **Partner inactive at payment** → dispatch fails, admin alert, manual reassign. (Phase 4/5)
- **Partial fulfillment** (partner re-prints one) → internal `outsource_status`, no customer impact. (Phase 5)
- **Customer change/cancel before dispatch sent** → dispatch is idempotent + guarded; a short pause window via order status check before send. (Phase 4)
- **Paid then refunded before dispatch** → never dispatch (guard on refund/cancel status). (Phase 4)
- **Paid, dispatched, then refunded** → cost already recorded on dispatch row; refund proceeds; partner still owed (data supports the reasoning). (Phase 4 + deferred QBO)
- **Low-res for target size** → warn at order time, never block. (Phase 6)

---

## 7. Blocked on Philip (commercial — brief open Qs)

Needed before **Phase 4** can actually send, and **Phase 6** can warn accurately:
1. First partner's **email address** (test target).
2. **Negotiated wholesale price per outsourced size.**
3. **Per-size quality threshold** image spec (for the low-res warning).
4. (Already have channel = email; partner turnaround optional/internal.)

Phases 1, 2, 3, 5, 7 proceed without these.

---

## 8. Customer-invisibility guardrails (brief §language rules)

Automated check / review checklist: no "outsourced / third party / partner / external printer" strings in any customer-facing surface (catalog API, bot replies, email, receipts, status, web copy). Larger sizes framed as "Premium Wall Prints / Large Format", turnaround stated as time only.

---

## 9. Definition of done (maps to brief §"What done looks like")

1–9 of the brief, minus QBO COGS (deferred): customer experience unchanged across bot + web; in-house orders flow as today; outsource orders auto-package + email to the default partner on payment with zero manual steps; partner receives unambiguous files + spec; admin manages partners + sees both streams with manual overrides; status collapses to the simple progression; promo slips unchanged; **no Epson references in active paths.** QBO COGS tracked in DB, posting follows in phase 2.

---

## 10. QA

A manual QA guide (numbered cases, expected results, defect log) will be produced per shipped phase before sign-off testing — not automated tests.
