# FusionPrints — Project State

**Paste this entire document at the start of every new conversation with Claude.**

This is the canonical source of truth for the project's current state. Update it whenever something material changes.

---

## Project at a glance

**Name:** FusionPrints
**What it is:** WhatsApp-driven photo and poster printing service for Zimbabwe (Harare-based)
**Founder:** Solo, technical, operates the system but doesn't write code
**Budget:** $5–20k for Phase 1
**Status:** Setting up dev environment, no code running in production yet

---

## Architecture summary

- **Backend:** Node.js 22 + TypeScript + Fastify + Drizzle ORM
- **Database:** PostgreSQL 16, self-hosted on Hetzner VPS (Phase 1)
- **WhatsApp:** 360dialog as BSP
- **Payments:** Paynow (local Zim) + Flutterwave (diaspora/international)
- **Image storage:** Backblaze B2
- **Print agent:** Separate Node service on Windows 11 mini-PC, drives DNP DS620A and Epson P900 printers
- **Dev env:** WSL2 Ubuntu on Windows, VS Code with WSL extension

---

## Product catalog (locked)

**Photo prints (DNP DS620A, except 8×10 on Epson):**
- 4×6 in / 10×15 cm
- 5×7 in / 13×18 cm
- 6×6 in / 15×15 cm
- 6×8 in / 15×20 cm
- 8×10 in / 20×25 cm

**Posters (Epson P900):**
- 11×14 in / 28×36 cm
- 12×18 in / 30×45 cm
- 16×20 in / 40×50 cm
- 18×24 in / 45×60 cm — **outsourced** (Phase 1.5)
- 24×36 in / 60×90 cm — **outsourced** (Phase 1.5)

Display sizes to customers in both inch and cm always.

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

**These prices are unvalidated against the local market. Pressure-test with Harare competitor quotes before launch.**

---

## What's been built so far

- Project skeleton: TypeScript + Fastify + Drizzle setup
- Database schema (all tables defined)
- Health-check endpoint
- Env validation
- Logger
- Migration + seed + reset scripts

## What's next on the build queue (in order)

1. Pricing engine (pure logic, easy to test)
2. Product catalog as code/data
3. Bot state machine (CLI-testable, no WhatsApp yet)
4. WhatsApp 360dialog integration
5. Paynow integration
6. Flutterwave integration
7. Print agent (separate codebase)
8. Admin dashboard

---

## Decisions deferred / open questions

- **Domain:** Need to register `fusionprints.co.zw` and `fusionprints.com`
- **WhatsApp number:** Need a fresh Zim SIM not currently on WhatsApp
- **Business registration:** PBC or similar — required for 360dialog and Paynow merchant accounts
- **Hardware:** Buy DNP DS620A + Epson P900 once vendor quotes are in
- **Premises:** Where the printers will physically live in Harare
- **Outsourcing partner:** Find a SA print shop willing to fulfill 18×24 and 24×36 orders for ZW delivery

---

## Operational status

- [ ] WSL2 + dev environment installed
- [ ] Sanity check passing (Postgres + Node working together)
- [ ] Repo cloned and running locally
- [ ] 360dialog account application submitted
- [ ] Paynow merchant account application submitted
- [ ] Flutterwave merchant account application submitted
- [ ] Domain registered
- [ ] Business registered (PBC)
- [ ] Hardware quotes received
- [x] WSL2 + dev environment installed
- [x] Sanity check passing
- [x] Repo cloned and running locally

---

## Conventions to remember

- All code in TypeScript, ES modules, strict mode
- Money in NUMERIC, never floats
- All timestamps timezone-aware
- Boring tech preferred (no React, no Docker, no Kubernetes in Phase 1)
- Order numbers: `FP-YYYY-NNNN`
- Currency: USD only

---

## Where things live

- **Code:** `~/dev/fusionprints` inside WSL Ubuntu
- **Decisions log:** `docs/decisions-log.md` in the repo
- **This file:** `docs/project-state.md` in the repo — keep up to date
