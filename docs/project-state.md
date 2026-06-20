# FusionPrints — Project State

**Paste this entire document at the start of every new conversation with Claude.**

This is the canonical source of truth for the project's current state. Update it whenever something material changes.

_Last refreshed: 2026-06-19._

---

## Project at a glance

**Name:** FusionPrints
**What it is:** Photo and poster printing service for Zimbabwe (Harare-based), ordered via a WhatsApp bot **and** a web storefront.
**Founder:** Solo, technical, operates the system but doesn't write code
**Budget:** $5–20k for Phase 1
**Status:** **Live in production.** Backend deployed on Hetzner (prod tip `867b180`); web storefront deployed on Vercel. Hardware/premises/vendor onboarding is the remaining real-world work (see `tasks.md`).

---

## Architecture summary

- **Backend:** Node.js 22 + TypeScript + Fastify + Drizzle ORM, self-hosted on a Hetzner VPS (systemd service `fusionprints`, Caddy reverse proxy).
- **Web storefront:** server-rendered routes under `/web/*`, deployed via Vercel.
- **Database:** PostgreSQL 16 on the Hetzner VPS. 23 migrations (`0000`–`0023`). Nightly Backblaze B2 backup.
- **WhatsApp:** 360dialog as BSP (`whatsapp-webhook.ts` → `bot/handler.ts` → `bot/state-machine.ts`).
- **Payments:** **Payonify** — Zimbabwe gateway (EcoCash / OneMoney / ZimSwitch / card) with a Stripe-style API; embedded checkout on web, EcoCash USSD push from the bot, confirmed by a signed webhook. (Magetsi + Stripe were never wired up and have been removed; Paynow/Flutterwave are not used.)
- **Image storage:** Backblaze B2. Originals auto-deleted post-fulfilment by data-retention sweeps.
- **Accounting:** QuickBooks Online integration (sales/refund receipts posted on fulfilment/cancel).
- **Print agent:** Separate Node service on a Windows 11 mini-PC, polls the backend's agent-API for jobs and drives the printers. (Backend side: `routes/agent-api.ts`, `services/virtual-printer.ts`.)
- **CI:** GitHub Actions — vitest blocking, typecheck project-wide.
- **Dev env:** WSL2 Ubuntu on Windows, VS Code with WSL extension.

---

## Printers

- **DNP DS620A** — dye-sub photo prints. Default media is 6×8; 5×7 requires an operator media swap (see "5×7 operator gating" below).
- **Epson SureColor P5300** — posters / large format. (Earlier docs called this the P900; the unit is the P5300.)

---

## Product catalog (locked)

**Photo prints (DNP DS620A, except 8×10 on Epson):**
- 4×6 in / 10×15 cm
- 5×7 in / 13×18 cm — **operator-gated** (next-working-day fulfilment)
- 6×6 in / 15×15 cm
- 6×8 in / 15×20 cm
- 8×10 in / 20×25 cm

**Posters (Epson P5300):**
- 11×14 in / 28×36 cm
- 12×18 in / 30×45 cm
- 16×20 in / 40×50 cm
- 18×24 in / 45×60 cm — **outsourced** (Phase 1.5)
- 24×36 in / 60×90 cm — **outsourced** (Phase 1.5)

Composite products (multi-photo layouts on a single print) are also supported. Display sizes to customers in both inch and cm always.

---

## Pricing model (provisional, USD)

| Size | Unit cost | Price | Margin |
|---|---|---|---|
| 4×6 | $0.18 | $0.80 | 78% |
| 5×7 | $0.35 | $2.00 | 83% |
| 6×6 | $0.35 | $2.00 | 83% |
| 6×8 | $0.38 | $2.50 | 85% |
| 8×10 | $0.90 | $5.00 | 82% |
| 11×14 | $1.65 | $10.00 | 84% |
| 12×18 | $2.25 | $14.00 | 84% |
| 16×20 | $3.60 | $22.00 | 84% |

Bulk: 10–49 prints = 15% off, 50+ = 25% off.
Delivery: $3 in Harare (CBD/Avondale), $5–7 greater Harare, quote-based elsewhere.
Prices and promos are admin-editable at runtime (`admin-pricing.ts`, `admin-promos.ts`, `product_prices` table).

**These prices are unvalidated against the local market. Pressure-test with Harare competitor quotes before scaling.**

---

## 5×7 operator gating (shipped 2026-06-19, migration 0023)

5×7 can't run on the default 6×8 DNP media, so it's operator-gated. The agent's job-serving endpoint only hands out dye-sub jobs whose media matches the loaded "DNP media mode" (`store_settings` singleton). Flipping to 5×7 releases held 5×7 jobs and auto-pauses the 4×6 family; flipping back resumes. Any order containing a 5×7 is pushed to the next working day (CAT; Sundays + ZW public holidays excluded, seeded in `holidays`); `applyFiveBySevenHandling` runs at `markOrderPaid`, sets `orders.scheduled_ready_at`, and WhatsApps the operator. Admin has a 6×8⇄5×7 toggle + held count + "regular prints paused" banner.

---

## What's been built (live)

- **WhatsApp bot** — full conversational ordering state machine, image validation, composites, 5×7 handling, order lookup. CLI bot simulators for testing.
- **Web storefront** — Google sign-in + email auth, catalog, photo upload + in-browser editor, Google Photos import, cart/checkout, Payonify embedded payment, order history, saved addresses, profile.
- **Payments** — Payonify embedded checkout (web) + EcoCash USSD push (bot), signed webhook → `markOrderPaid`, admin manual mark-paid fallback, auto-cancel of abandoned checkouts after 24h.
- **Admin dashboard** — orders/ops, poster approval, mark-ready, pricing, promos, fonts, session auth + per-IP rate limiting.
- **Pricing engine** — quotes, bulk discounts, delivery, runtime overrides.
- **Print agent API** — polling endpoint for the Windows agent, media-mode gating, virtual-printer service for local testing.
- **Accounting** — QuickBooks Online sales/refund receipt posting.
- **Slip system** — print/collection slip rendering (see `docs/slip-system.md`).
- **Ops** — Backblaze B2 image storage + nightly DB backup, data-retention sweeps (originals deleted post-fulfilment), hardened deploy, logging hardening, security (Origin allowlist, rate limiting, decompression-bomb guards), opaque public order references.

## Remaining engineering

- See `docs/tasks.md` Track H for any open software items.
- Known pending code task: none blocking. (The WhatsApp "payment status" TODO was resolved 2026-06-19 — payment is confirmed by the Payonify webhook, not inbound messages.)

---

## Decisions deferred / open questions (real-world)

- **Domains:** `fusionprints.co.zw` + `fusionmoments.co.zw` registered. Cloudflare/DNS + redirect + email forwarding still to wire up.
- **WhatsApp number:** dedicated Zim SIM + 360dialog API approval + credentials.
- **Payments:** Payonify live credentials on prod.
- **Hardware:** buy DNP DS620A + Epson P5300 once vendor quotes are in.
- **Premises:** where the printers physically live in Harare (power, internet, security).
- **Outsourcing partner:** SA print shop for 18×24 and 24×36.
- **5×7 alerts:** set `OPERATOR_WHATSAPP_PHONE` + `WHATSAPP_TEMPLATE_5X7_HOLD` on prod; supply final customer brand copy.

---

## Conventions to remember

- All code in TypeScript, ES modules, strict mode
- Money in NUMERIC, never floats
- All timestamps timezone-aware (CAT for working-day math)
- Boring tech preferred (no React, no Docker, no Kubernetes in Phase 1)
- Order numbers: `FP-YYYY-NNNN` (+ an opaque public reference)
- Currency: USD only
- Code style: simple over clever, boring over elegant, heavily commented

---

## Where things live

- **Code:** `~/dev/fusionprints` inside WSL Ubuntu
- **Prod backend:** Hetzner VPS, app at `/home/fusionprints/app`, systemd service `fusionprints`, env in `.env`, restart `sudo systemctl restart fusionprints`
- **Decisions log:** `docs/decisions-log.md`
- **Task tracker:** `docs/tasks.md`
- **This file:** `docs/project-state.md` — keep up to date
