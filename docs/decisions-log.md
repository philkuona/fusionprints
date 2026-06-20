# Decisions Log

A running record of architectural and business decisions made during the FusionPrints build.

Format: each decision is dated, has a context, the decision itself, and consequences. When a decision is later overturned, leave the original entry but add a new one explaining the reversal.

---

## 2026-04-29 — Initial architecture

**Context:** Starting the project. Solo founder, $5–20k budget, technical-but-not-developer, will operate the system themselves.

**Decisions:**
- **Language**: TypeScript on Node.js 22.
- **Framework**: Fastify (lighter than Express, better TypeScript story).
- **Database**: PostgreSQL 16, self-hosted on the same VPS as the backend. Single VPS in Phase 1.
- **ORM**: Drizzle (lighter than Prisma, easier to debug, raw SQL accessible).
- **Hosting**: Hetzner Cloud, Falkenstein region, CX22 instance (~$5/month). Latency to Zim is ~200ms but acceptable for this workload.
- **Image storage**: Backblaze B2 (S3-compatible, cheap egress).
- **WhatsApp BSP**: 360dialog (Africa-friendly, no Meta markup).
- **Payments**: Paynow for local Zim payments, Flutterwave for diaspora/international.
- **Dev environment**: WSL2 + Ubuntu on the user's Windows machine. Production matches dev.
- **Print agent OS**: Windows 11 Pro on a dedicated mini-PC. Better driver story for Epson and DNP than Linux.
- **Admin dashboard**: Plain HTML + HTMX, server-rendered. No React in Phase 1.
- **Currency**: USD-only at launch.
- **Language**: English-only at launch.

**Consequences:**
- Single point of failure on the VPS — accepted for Phase 1.
- User is the database administrator — accepted, with the option to migrate to managed Postgres if it becomes a burden.
- Developer experience is roughly as good as it gets without being expensive.

---

## 2026-04-29 — Product catalog locked

**Context:** Need a clear SKU list to design pricing, ordering flow, and printer hardware purchases around.

**Decisions:**

Photo prints (5 SKUs, all on DNP DS620A):
- 4×6 (10×15 cm)
- 5×7 (13×18 cm)
- 6×6 (15×15 cm)
- 6×8 (15×20 cm)
- 8×10 (20×25 cm) — printed on Epson P900

Posters (3 in-house + 2 outsourced):
- 11×14 (28×36 cm) — Epson P900
- 12×18 (30×45 cm) — Epson P900
- 16×20 (40×50 cm) — Epson P900
- 18×24 (45×60 cm) — outsource for now (Phase 1.5)
- 24×36 (60×90 cm) — outsource for now (Phase 1.5)

Sizes always shown to customers in **both inches and cm** simultaneously.

**Consequences:**
- Fewer SKUs simplifies operations dramatically: only 2 media types in stock at launch.
- 18×24 and 24×36 require outsourcing or deferring; we'll outsource via SA partner.

---

## 2026-04-29 — Business name

**Context:** Need a name to commit to code, domain, payment merchant accounts, branding.

**Decision:** **FusionPrints**

- No conflicts with existing Zimbabwean printing companies (only loose match was FutureFusion in South Africa, different name and market).
- Verify and register `fusionprints.co.zw` and `fusionprints.com`.

**Consequences:**
- Project codenamed `fusionprints` everywhere (folder, package, database).
- Order numbers prefixed `FP-YYYY-NNNN`.
- Bot identifies as "FusionPrints" to customers.

---

## 2026-04-29 — Build approach

**Context:** Founder will not hire a developer or write code themselves; Claude produces all code, founder operates it.

**Decision:**
- All code produced by Claude across multiple conversations.
- Founder operates: deploys, monitors, debugs production issues with Claude's help.
- Code style: simple over clever. Boring over elegant. Heavily commented.
- Tier 2 technical decisions (small, reversible choices) made by Claude without asking.
- Risky or expensive decisions flagged before commitment.

**Consequences:**
- Build pace bounded by founder's ability to operate, not by code production.
- Documentation and runbooks become as important as the code itself.
- Memory across conversations is the founder's responsibility — keep this doc updated.

---

## 2026-06-19 — Payments: Payonify, not Paynow/Flutterwave/Magetsi/Stripe

**Context:** The original plan (2026-04-29) named Paynow + Flutterwave, and the code later carried Magetsi (EcoCash) and Stripe (card) stubs. None were ever wired up. Payonify — a Zimbabwe gateway (EcoCash / OneMoney / ZimSwitch / card) with a Stripe-style API and signed webhooks — was integrated instead and is now the live provider.

**Decision:**
- **Payonify is the sole payment gateway.** Web uses its embedded Drop-In checkout; the WhatsApp bot uses its EcoCash USSD push. A signed webhook (`/web/api/payments/payonify/webhook`) is the source of truth → `markOrderPaid`.
- **Magetsi and Stripe are dropped.** Their dead stub code (webhook endpoints, `createCardCheckoutUrl`, the never-emitted bot `INITIATE_CARD_PAYMENT` effect, env vars) was removed (commit `6a8f420`).
- Card in the **bot** stays hidden (EcoCash-only); card is available on the **web** via Payonify.
- QBO reconciliation account renamed **Stripe → Payonify** (`payonifyAccountId`); requires renaming the account in the QuickBooks chart of accounts + re-running QBO setup on prod.

**Consequences:**
- `PAYMENT_PROVIDER` is now just `stub | payonify`. Paynow/Flutterwave references in older docs are obsolete.
- One gateway covers both local and diaspora/card — simpler than the original two-provider plan.

---

## 2026-06-19 — 5×7 prints are operator-gated, next-working-day

**Context:** The single DNP DS620A prints one media family at a time; the default is 6×8. 5×7 needs a physical media swap, so it can't be served on demand.

**Decision:**
- 5×7 dye-sub jobs are **held** by a "DNP media mode" gate (`store_settings` singleton); the print agent is only served jobs matching the loaded media. Switching to 5×7 in admin releases the held batch and **pauses** the 4×6/6×8 family; switching back resumes.
- Any order containing a 5×7 is pushed to the **next working day** (CAT; Sundays + ZW public holidays excluded). `applyFiveBySevenHandling` at `markOrderPaid` sets `scheduled_ready_at` and alerts the operator on WhatsApp.

**Consequences:**
- Migration 0023 + seeded holidays. Customers see the next-day date on web + bot. Operator gets a toggle + held count + "regular prints paused" banner.
- Requires `OPERATOR_WHATSAPP_PHONE` + `WHATSAPP_TEMPLATE_5X7_HOLD` on prod for the operator alert to send (until set, it only logs).

---

## 2026-06-19 — Printer naming: Epson P5300 (not P900)

**Context:** Early docs/seed referenced an Epson SureColor **P900**. The actual large-format unit is the **P5300**.

**Decision:** Use **Epson SureColor P5300** in all display, comments, and seed data (commit `1c466f7`).

**Consequences:** Cosmetic/display only — no routing or pricing change. Older docs mentioning "P900" are superseded.

---

## How to add a new entry

When something significant changes (architecture, scope, vendor choice, business decision), copy this template:

```
## YYYY-MM-DD — Short title

**Context:** Why this decision came up.

**Decision:** What you decided.

**Consequences:** What this means for the project, including any trade-offs accepted.
```

Add it at the bottom of this file. Don't edit historical entries — add new ones that supersede them.
