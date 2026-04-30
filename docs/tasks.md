# FusionPrints — Task Tracker

Last updated: 2026-04-29
Update this file whenever a task is completed. Bring it into every conversation with Claude.

Legend: [ ] Not started | [~] In progress | [x] Done

---

## 🏗️ TRACK A: Business & Legal

### Company Registration
- [x] Existing registered Zimbabwe business — FusionPrints trades under it
- [ ] Register "FusionPrints" as a trading name under the existing business
      → Simple name registration, not a full company registration
      → Check with CIPAZ or your existing accountant/agent
      → Time: usually 1–5 days once submitted
      → You'll get a trading name certificate — some vendors may ask for this

### Bank Account
- [x] Wise Business account confirmed for international/USD payments
      → Confirm Wise supports receiving payouts from Flutterwave
      → Confirm Wise supports receiving payouts from Paynow
      → Note: Paynow may require a local ZWL/USD bank account in addition to Wise
         — confirm this during the application process

### Documents Ready
- [x] Existing business registration certificate available
- [x] Director ID copies available
- [x] Company documents ready to submit to 360dialog, Paynow, Flutterwave

### Domain & Web Presence
- [x] fusionprints.co.zw registered
- [x] fusionmoments.co.zw registered (will redirect to fusionprints.co.zw)
- [ ] fusionprints.com not available — register alternative when needed
      → Options: fusionprintszw.com, getfusionprints.com
- [ ] Set up Cloudflare account (free) — cloudflare.com
      → Point both .co.zw domains to Cloudflare nameservers
- [ ] Configure fusionmoments.co.zw → 301 redirect to fusionprints.co.zw
- [ ] Set up email forwarding: hello@fusionprints.co.zw → your personal email

---

## 💳 TRACK B: Payment Processing

### ⚡ You can start both of these NOW — documents are ready

### Paynow (EcoCash, OneMoney, Zimswitch, local cards)
- [ ] Apply at paynow.co.zw
      → Documents: business registration cert, director ID, bank account details,
         proof of business address
      → Explicitly request API integration access, not just the merchant portal
      → Confirm whether Wise is accepted as payout account
      → Time: 1–2 weeks
- [ ] Receive API credentials (Integration ID + Integration Key)
- [ ] Add credentials to .env file in the project

### Flutterwave (diaspora + international card payments)
- [ ] Apply at flutterwave.com → select Zimbabwe
      → Same documents as Paynow + additional KYC likely
      → Wise Business should work as payout account
      → Request API access from the start
      → Time: 1–3 weeks
- [ ] Receive API credentials (Public Key + Secret Key + Webhook Hash)
- [ ] Add credentials to .env file in the project

---

## 📱 TRACK C: WhatsApp Business API

### ⚡ Get the SIM this week — 360dialog takes 2–4 weeks to approve

- [ ] Get a dedicated SIM card for the FusionPrints WhatsApp number
      → Must NOT be currently on regular WhatsApp
      → If it is: delete WhatsApp on that number and wait 30 days
      → A brand new Zim SIM is the cleanest option
- [ ] Sign up at 360dialog.com and submit WhatsApp Business API application
      → Documents: business registration cert, the dedicated phone number
      → Specify API access (not just the standard WhatsApp Business app)
      → Cost: ~€49/month base + ~$0.01–0.02 per order in conversation fees
      → Time: 2–4 weeks for Meta verification
- [ ] WhatsApp Business API approved
- [ ] Receive API credentials (API key, phone number ID)
- [ ] Add credentials to .env file in the project

---

## 🖨️ TRACK D: Hardware

### Get Quotes First — Don't Buy Until Budget Confirmed

- [ ] Contact DNP authorized distributors in South Africa (DNP DS620A)
      → Search: "DNP DS620A South Africa distributor"
      → Ask for: unit price + 6×8 ribbon media (6 months supply) +
         freight to Harare + ZIMRA import duty tariff code
- [ ] Contact Epson South Africa (SureColor P900)
      → Ask for: unit price + full 10-cartridge ink set + 17" luster paper roll
         (6 months supply) + freight to Harare + import duties
- [ ] Get Harare IT shop quotes for:
      → Mini-PC (Windows 11 Pro) — the print server machine
      → UPS — non-negotiable in Zimbabwe
      → Color-calibrated monitor (for proofing)
      → Monitor calibrator (Datacolor Spyder or X-Rite ColorMunki)
- [ ] Calculate total landed costs (unit + freight + duties) for all hardware
      → This is the number that confirms the $5–20k budget works

### Supply Chain Confirmation
- [ ] Confirm DNP 6×8 ribbon ongoing supply to Zimbabwe
      → Who distributes in SA, shipping time, minimum order quantities
- [ ] Confirm Epson 17" roll paper ongoing supply to Zimbabwe

### Hardware Purchase (after premises decided + landed costs confirmed)
- [ ] DNP DS620A + 6 months ribbon media
- [ ] Epson SureColor P900 + ink set + 6 months paper roll
- [ ] Mini-PC (Windows 11 Pro) + UPS + calibrated monitor + calibrator

---

## 📍 TRACK E: Operations & Premises

- [ ] Decide where printers will live (home / rented room / partner business)
      → Affects: power setup, security, collection logistics, print server uptime
- [ ] Confirm stable power supply + correctly sized UPS at that location
- [ ] Confirm reliable internet at that location (business fibre preferred)
- [ ] Confirm customer collection address in Harare
      → This goes into every bot message and customer notification
- [ ] Confirm collection hours (suggested: Mon–Sat, 9am–6pm)
- [ ] Identify a reliable Harare courier for delivery orders
      → Options: Courier Connect, local motorbike courier services
      → Target: $3 flat rate within CBD/Avondale

### Large Format Outsourcing (18×24 and 24×36)
- [ ] Find a South Africa print shop for large format fulfillment
      → Try: Foto First, Orms (Cape Town), Photolab (JHB)
      → Ask for: wholesale rates, turnaround time, shipping cost to Harare
      → Need at least one confirmed partner before launch

---

## 💰 TRACK F: Market Validation

- [ ] Get print quotes from 3 Harare print shops
      → Sizes to quote: 4×6, 5×7, 8×10 photo + 11×14, 16×20 poster
      → Compare against FusionPrints pricing model
      → Update docs/project-state.md pricing if needed
- [ ] Talk to 2–3 Harare photographers (wedding / event / portrait)
      → Current printing workflow? Pain points? Willingness to pay for delivery service?
      → These are potential bulk account customers from day one
- [ ] Test ordering from 2 local WhatsApp-based businesses in Zim
      → Note friction points — direct UX research for your bot design

---

## ☁️ TRACK G: Infrastructure Accounts

- [ ] Hetzner Cloud account — hetzner.com (free until you provision)
- [ ] Backblaze B2 account — backblaze.com (free until you store data)
- [ ] Better Stack account — betterstack.com (free tier, for monitoring + alerts)
- [ ] GitHub account + private "fusionprints" repository
- [ ] Push local project to GitHub
      → Commands provided when you're ready for this
- [ ] ngrok account — ngrok.com (for webhook testing during development)

---

## 💻 TRACK H: Software Build

### Foundation ✅
- [x] WSL2 + Ubuntu 24.04
- [x] Node.js 22
- [x] PostgreSQL 16
- [x] VS Code + WSL extension
- [x] Project skeleton running locally
- [x] Database schema migrated (8 tables)
- [x] Printers seeded (DNP DS620A + Epson P900)
- [x] Product catalog (10 SKUs, inch + cm labels)
- [x] Pricing engine (quotes, bulk discounts, delivery, WhatsApp summaries)

### Bot Logic
- [ ] Bot state machine — CLI simulator (type messages, see bot responses)
- [ ] Image validation service (resolution check, compression detection)
- [ ] Order creation service (confirmed cart → database order)
- [ ] WhatsApp 360dialog integration (bot wired to real WhatsApp number)

### Payments
- [ ] Paynow integration + webhook handler
- [ ] Flutterwave integration + webhook handler
- [ ] Webhook signature verification (security — prevents fake payment confirmations)
- [ ] Payment reconciliation job (catches missed webhooks every 15 min)

### Operations
- [ ] Admin dashboard (orders list, poster approval, mark ready for collection)
- [ ] Print job queue service
- [ ] Customer notification service (payment confirmed, order ready)
- [ ] Automated image cleanup (delete originals 30 days post-fulfillment)

### Print Agent (separate codebase — Windows mini-PC)
- [ ] Print agent project setup
- [ ] DNP DS620A driver integration
- [ ] Epson P900 driver integration
- [ ] Image → print-ready file generation (ICC profiles, correct dimensions)
- [ ] Job polling loop (checks backend every 30 seconds for new jobs)
- [ ] Failure handling + alert to your WhatsApp on error

### Production Deployment
- [ ] Provision Hetzner VPS (CX22, ~$5/month)
- [ ] Deploy backend to production server
- [ ] Configure Caddy (reverse proxy + auto-HTTPS)
- [ ] Automated daily database backups
- [ ] Uptime monitoring via Better Stack
- [ ] Domain A records pointed to VPS IP

---

## 🎯 PRIORITY ORDER RIGHT NOW

1. **[x] Dev environment + project running** ✅
2. **[ ] Apply for Paynow** — documents ready, do it today
3. **[ ] Apply for Flutterwave** — documents ready, do it today
4. **[ ] Get a dedicated SIM** — then apply to 360dialog immediately
5. **[ ] Register FusionPrints trading name** — quick, unblocks some vendors
6. **[ ] Get hardware quotes** — DNP + Epson + Harare IT
7. **[ ] Get competitor pricing** — 3 Harare print shops
8. **[ ] Decide on premises** — needed before hardware purchase
9. **[ ] Find SA outsourcing partner** — needed before selling large formats
10. **[ ] Continue software build** — bot state machine is next

---

## 📝 NOTES & UPDATES

2026-04-29 — Domains registered: fusionprints.co.zw + fusionmoments.co.zw
2026-04-29 — Existing Zimbabwe business confirmed — only trading name registration needed
2026-04-29 — Wise Business account confirmed for international payments
2026-04-29 — Business documents confirmed ready for all applications
2026-04-29 — Dev environment fully operational (WSL2 + Node + Postgres + VS Code)
2026-04-29 — Project skeleton running locally, health check passing
2026-04-29 — Pricing engine built and tested — all scenarios correct
