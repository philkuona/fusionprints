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

### Phase 2 — Partner model + admin directory — ✅ DONE (branch `feat/outsource-phase2-partner-directory`)
- Migration **0038** (`outsource_partners`) — table + `partner_channel` enum. (Numbering: actual tip was 0037, so this is 0038, not 0039 as the draft guessed.)
- New `services/outsource-partners.ts`: CRUD + `getDefaultPartner()` (returns the **active** default only) + single-default invariant enforced in the service + pure `normalizePartnerInput()` form parser + `outsourcedSizeCodes()`.
- Admin page `/admin/partners` on the `admin-theme.ts` shell + new "Partners" nav tab (full-admin only): add / edit / **make default** / **deactivate** (never delete — keeps historical dispatches coherent), per-size supported checkboxes + wholesale price inputs.
- New `tests/outsource-partners.test.ts` (6 cases) pins the pure parser.
- **Deviations from draft (deliberate):** contact channels are **discrete columns** (`contact_email`/`whatsapp_number`/`portal_url` + `preferred_channel` enum) rather than a JSONB array — clearer to render/edit and email is the only v1 channel; `supported_sizes` + `wholesale_prices` are JSONB (consistent with existing `layoutPayload`/`inkLevels`); turnaround is a single internal free-text field (per-size turnaround deferred — not needed for v1). **Dispatch-history-per-partner** view is deferred to Phase 4/5 (the `outsource_dispatches` table doesn't exist yet).
- **No behaviour change** to any existing flow — purely additive (new table, new admin page, new nav tab).
- **Deploy note:** migration 0038 must be applied on prod (`npm run db:migrate`) before the partners page works.

### Phase 3 — Print-ready package — ✅ DONE (branch `feat/outsource-phase3-print-package`)
- New `services/outsource-package.ts`:
  - **Print-ready render with embedded sRGB:** web items re-emit their existing `processedImages` bytes through `sharp().withIccProfile('srgb')` (q95, 4:4:4); raw/WhatsApp items are cover-fit to the size's recommended resolution oriented to the source aspect, then sRGB-embedded. Verified `.withIccProfile('srgb')` actually embeds the profile (sharp metadata: no ICC before → present after, space `srgb`).
  - **Filename:** `{orderRef}_{lineItem}_{size}_{finish}_x{qty}.jpg` (`printReadyFilename`, slug-safe for email/WhatsApp).
  - **Spec PDF** (`buildSpecSvg` → sharp PNG → pdf-lib, mirroring `receipt-pdf.ts`) + **spec JSON** (`buildSpec`, schema `fusionprints.outsource.v1`): order ref, per-item size/finish/qty/border + plain-language instructions. **No customer name/phone/price** — the spec type structurally has no such field (test-enforced).
  - **ZIP** via `jszip` (added dep) — `zipFiles()` bundles images + PDF + JSON.
  - `buildOutsourcePackage(orderId)` assembles it all (attaches the active default partner for the dispatcher; returns null if the order has no outsourced items).
- New `tests/outsource-package.test.ts` (7 cases): filename convention, spec shape + PII-safety, spec SVG, zip round-trip. DB/render functions need a database → covered by the Phase-3 QA guide, not unit tests.
- Dispatch (email send) is **Phase 4** — this phase only builds the package.

### Phase 4 — Auto-dispatch + dispatch record — ✅ DONE (branch `feat/outsource-phase4-auto-dispatch`)
- Migration **0039** (`outsource_dispatches`) + `outsource_dispatch_status` enum. (Numbering: 0039, following 0038 — not 0040 as the draft guessed.)
- `services/outsource-dispatch.ts`: `dispatchOrder()` builds the Phase-3 package → resolves the active default partner + channel → emails the ZIP via Resend (q95 sRGB files + spec PDF/JSON) → writes an `outsource_dispatches` row with the **wholesale-cost snapshot at send time**. Retries (initial + 1) with backoff; hard failure → `failed` row + ops alert (`sendOutsourceDispatchFailedAlert` in operator-email).
- Hooked into `markOrderPaid` as **fire-and-forget** (`autoDispatchOnPaid`) after the QBO step — package render + email is slow and must never block/roll back a paid order. No-ops when the order has no outsourced items.
- Guards: idempotent on order id (`alreadyDispatched` — a live dispatch blocks re-send unless forced); a missing/inactive/non-email/no-email partner records a `failed` row + alerts (never silently drops).
- Manual-override **service functions** present: `resendDispatch`, `dispatchToPartner`, `markDispatchManuallyFulfilled`, `getDispatchesForOrder`. **Admin UI that calls them is wired in Phase 5** with the dual-stream order view (kept here as backend only to avoid orphan endpoints).
- **Email address is admin-entered** (partner `contact_email` from Phase 2) — no env var, nothing hardcoded. Dispatch goes live the moment a default partner with an email exists; until then it records `failed` + alerts.
- New `tests/outsource-dispatch.test.ts` (10 cases): cost snapshot, target/channel resolution, idempotency guard.
- **Deploy:** apply migration **0039**. v1 sends over email only (non-email channels record `failed` with a clear reason).

### Phase 5 — Dual-stream status + admin order view — ✅ DONE (branch `feat/outsource-phase5-dual-stream-status`)
- Migration **0040** (`orders.outsource_status` + `order_outsource_status` enum: not_applicable/pending/dispatched/received/failed).
- **Finally applied the Phase-1-deferred change:** `enqueuePrintJobsForOrder` now **skips in-house jobs for outsourced items** (they're dispatched, not printed here) and the approval gate + slip gate (`queueOrderSlips`) key off **in-house items only** (outsourced posters no longer wrongly hold an order in approval). `markOrderPaid`→enqueue sets `outsource_status='pending'` (conditional, won't clobber a later state on webhook retry).
- **Rollup gate:** new pure `canAdvanceToPrinted(status, outsourceStatus, pendingJobs)` + `checkAndAdvanceToPrinted(orderId)` in `order.ts` — an order reaches `printed` only when all in-house print+slip jobs are terminal AND the outsource stream is `not_applicable`/`received`. The agent `done` endpoint now calls this (shared logic, no drift).
- Dispatch transitions: `dispatchOrder` sets `dispatched`/`failed`; new `markOutsourceReceived` + `markDispatchManuallyFulfilled` set `received` (and advance the latest dispatch row to `received_back`). The import cycle with `order.ts` is avoided — dispatch only writes the status column; the admin-ops endpoints run the rollup.
- **Admin order modal:** `getOrderDetails` returns an `outsource` block (status, dispatch history with partner/channel/timestamp/cost/error, active partners list); the modal shows an "Outsource — wall prints" section with **Re-send / Mark received / Mark manually fulfilled / Send-to-selected-partner** actions (new `/admin/api/ops/orders/:id/outsource-*` endpoints, both roles).
- **Customer-facing: no change** — `outsource_status` is admin-only; the web/bot status mapping is untouched.
- **Deviation:** stored only `orders.outsource_status` (not a separate `in_house_status` column) — in-house completion is derived from the existing jobs, so there's nothing to drift.
- New `tests/order-printed-gate.test.ts` (5 cases) pins the gate. Pure no-op for non-outsource orders.
- **Deploy:** apply migration **0040** (now the 3rd pending: 0038, 0039, 0040).

### Phase 6 — Low-res warning at order time — ✅ ALREADY IMPLEMENTED (no change needed)
- The web app already has this: `lib/editor/resolution.ts` grades pixel area against each product's `minResolution`/`recommendedResolution` (ok/warn/bad). The **size picker** flags sizes that can't print sharp against the full photo; the **crop modal** grades the actual cropped area and, on `bad`, asks for confirmation ("Print anyway" / "Keep editing") rather than blocking — exactly the brief's "warn at order time, never block (customer's choice)." Driven by the catalog thresholds, so it already covers the outsourced sizes (8×10 + wall art). **Nothing to build.** (Tuning the exact per-size thresholds is a content tweak in the catalog if/when Philip provides them — no code change.)

### Phase 7 — Retire Epson from active paths — ✅ DONE (branch `feat/outsource-phase7-retire-epson`)
- **catalog.ts:** dropped `'epson_p900'` from the `printer` union and made `printer` **optional** (outsourced sizes have no in-house printer); removed the `printer` field from the 4 outsourced products; `getTargetPrinterType` now only maps the two DNP values and **throws** if called on a printer-less (outsourced) product (it's only ever called on in-house items).
- **seed.ts:** removed the Epson printer row (only the DNP DS620A is seeded now).
- **Migration 0041** (hand-authored data migration, snapshot chain extended): `DELETE FROM printers WHERE printer_type = 'inkjet'` — removes the seeded Epson row from existing DBs so it stops showing on the admin Printers page.
- **agent-api test endpoint:** dropped the `inkjet` branch (dev-only; only dye-sub prints in-house now).
- **pg enums kept** (`printer_type` / `target_printer_type` still carry `'inkjet'`) to avoid a destructive migration — documented as retired; nothing routes to it. The admin `inkHtml` inkjet branch is now dead (no inkjet row exists) but gracefully renders dye-sub, so it's left as benign defensive code.
- Updated `tests/fulfillment-routing.test.ts`: outsourced products have no `printer` and `getTargetPrinterType` throws on them.
- **Deploy:** apply migration **0041** (4th pending: 0038, 0039, 0040, 0041).

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
