# Composite Products (Wallet · Passport · Mini Prints)

Design + implementation summary for the composite-print feature. Three new
products that lay **multiple photos onto one 4×6 dye-sub sheet** via server-side
compositing — **no new hardware, no new media**. Built across 3 repos as 3 PRs.

Source of truth for layouts/borders: `FusionPrints_Composite_Schema.ts` (the
founder-supplied schema; cells/mappings/border presets used verbatim).

Last updated 2026-06-07.

---

## 1. The products

| Code | Product | Sheet | Cells | Cut lines | Price | WhatsApp default |
|------|---------|-------|-------|-----------|-------|------------------|
| `wallet_4up` | Wallet Prints (Set of 4) | 4×6 | 4 × 2×3 (2col×2row) | vert x=2; horiz y=3 | $2.50 | 1 photo, duplicated ×4 |
| `passport_6up` | Passport Photos (Set of 6) | 4×6 | 6 × 2×2 (2col×3row) | vert x=2; horiz y=2, y=4 | $3.00 | 1 photo, duplicated ×6 |
| `mini_pair` | Mini Prints (Pair) | **6×4 landscape** | 2 × 3×4 side-by-side | vert x=3 | $2.00 | 2 unique photos |

- **Cut lines** are faint dashed grey (~`#888888`, ~40% opacity), always rendered
  on the printed sheet — never toggleable. The customer cuts along them.
- **Mini** is composed *landscape* (6×4) then **rotated 90° by the agent** to
  print on portrait-fed 4×6 paper (`layout.printRotation = 90`). A **portrait
  toggle** (web editor only) stacks the two photos 4×3 on a 4×6 sheet instead.
- Prices are admin-editable like any product (`product_prices` overrides).

---

## 2. Data model (backend `fusionprints`)

- **Catalog** (`src/config/catalog.ts`): composite products live in the same
  `PRODUCTS` array (so pricing/orders/admin/agent reuse one pipeline).
  - `ProductType` extended with `'composite'`. (The schema brief calls single
    prints `'standard'`; we kept the established `'photo_print'` value to avoid
    churning the DB enum + bot.)
  - `Product` gains optional `displayName`, `description`, `layout`.
  - New types: `PrintLayout`, `LayoutCell`, `EditorConfig`, `BorderOption`;
    constants `BORDER_PRESETS`, `DEFAULT_COMPOSITE_EDITOR`; helpers
    `COMPOSITE_PRODUCTS`, `isComposite()`. The layout carries `sheetWidth/Height`
    + `printRotation` so the agent is self-contained.
- **DB** (`src/db/schema.ts`, migration `0018_composite_products`):
  - `product_type` enum `+= 'composite'`.
  - `order_items.layout_payload` jsonb — `{ cells: [{ cellIndex, imageId,
    transform, border }], orientation? }`. Null for standard single-photo items.

---

## 3. Order flows

Both channels write the **same `order_items.layout_payload`** and route through
the **same fulfilment pipeline** (print queue, status, receipts, QBO).

### WhatsApp (default flow)
`src/bot/` — the product menu is an interactive **list** (6 options). New states:
`choosing_wallet_photo` / `choosing_passport_photo` (1 photo → duplicated across
cells) and `choosing_mini_photo_1` / `_2` (2 unique photos). Per-cell resolution
warnings; `BACK` → menu; global `RESET`/`CANCEL` honoured. `createOrder` writes
`layout_payload` (transform/border null) and maps cart↔quote **by index** (this
also fixed a latent duplicate-`sizeCode` photo collision).

### Web (composite editor)
`fusionprints-web` — mega menu → product page → editor → cart → checkout.
`createWebOrder` + `/web/api/checkout` accept composite items (validate the
`sizeCode` is a composite product and every cell photo belongs to the user) and
persist `layout_payload`. On payment, `enqueueWebPrintJobs` queues a
`dye_sub_4x6` print job like any 4×6.

### Agent job API
`GET /api/agent/jobs/next` returns a `composite` block for composite items:
`{ layout, cells: [{ cellIndex, imageStorageKey, imageUrl, transform, border }] }`
(cells resolved to B2 keys + signed URLs). Non-composite jobs unchanged.

---

## 4. Agent compositor (`fusionprints-agent`)

`src/composite-renderer.ts` (`renderComposite`): white 300-DPI canvas →
per-cell download (B2) + optional inset border + cover-fit (+ per-cell
transform when present) + composite at the cell offset → dashed grey cut-line
SVG overlay → **rotate `printRotation`** (mini = 90°) → 300-DPI JPEG.
`agent.ts` routes composite jobs to it before dispatch; `printer-driver.ts`
maps composite size codes to **4×6 media**. WhatsApp orders send no transforms
(cover-fit default); the web editor sets them.

---

## 5. Web platform (`fusionprints-web`)

- **Mega menu** (`lib/navigation.ts` + `components/mega-menu.tsx`): data-driven;
  Photo Prints + Wall Art are non-clickable parents that expand to their
  products. Keyboard + ARIA; mobile accordion. Add a product = config change.
- **Composite editor** (`components/composite-editor/*`, `lib/composite-editor/`,
  `lib/composite-products.ts`): per-cell upload, **CSS-based** live preview
  (positioned cells, cover-fit + CSS transform pan/zoom/rotate, per-cell borders,
  always-on dashed cut guides, inset selection highlight), border swatches +
  "apply to all", "use one photo for all", mini orientation toggle, Add to cart.
  - **Library note:** the *current* brief specifies editor behaviour, not a
    library (Konva/Zustand were only in an earlier, discarded brief). CSS preview
    was chosen for reliability + mobile; state is `useReducer` (consistent with
    the photo editor). The cart carries `layoutPayload`; checkout sends it.
- **Product pages**: `/prints/wallet`, `/prints/mini`, `/prints/passport`.
- **Upsell card**: homepage "More ways to print" row → `/prints/mini`. The
  visual is Gemini-generated (`public/images/upsell-mini-prints.jpg`); the
  headline / subline / CTA / "Hold the moment." are **HTML over the image**
  (text is never baked into AI images).

---

## 6. The 3 PRs

| PR | Repo | Scope |
|----|------|-------|
| 1 | `fusionprints` | catalog + types, migration `0018`, WhatsApp flows, order persistence (WhatsApp + web checkout/`createWebOrder`), admin composite tag, agent job-API composite block |
| 2 | `fusionprints-agent` | `composite-renderer` (cells + cut lines + borders + mini rotation), dispatch wiring, 4×6 media routing |
| 3 | `fusionprints-web` | mega menu, composite editor + product pages, upsell card, checkout carries `layout_payload` |

**Merge order:** 1 → 2 → 3. After #1: `npm run deploy` (applies `0018`). After
#2: update the agent on the print PC. #3 auto-deploys on Vercel.

---

## 7. Testing

- Payments are virtualised → test orders are free (web + WhatsApp).
- Order flow + admin (`layout_payload`, composite tag) are testable on prod once
  merged + deployed. **Virtual printers do NOT render** — they mark jobs done
  in-process; to verify an actual composited sheet you need the **real agent
  (#2)** running against a paid order.
- ⚠️ Turn `VIRTUAL_PRINTERS` **off** before launch.

---

## 8. Deferred (post-launch)

- **Photo Strips** (2× 2×6 photobooth) and **Tiny Mini Prints** (8-up) — stubbed
  in the schema, intentionally out of scope.
- Editor polish: pinch-zoom / two-finger rotate on touch, richer per-cell
  transform handles, a real-device pass (same gate class as the photo editor).
