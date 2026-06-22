# WhatsApp Message Templates — to submit for approval

Order-status notifications to customers must use **pre-approved WhatsApp message
templates** to deliver outside the 24-hour customer-service window (e.g. web
orders, or next-day 5×7 pickups). Submit these in the **360dialog dashboard**
(WhatsApp Manager → Message Templates), then set the matching env var to the
**approved template name** and restart the backend.

- **Category:** `UTILITY` (transactional order updates — approved fast, no
  marketing opt-in needed).
- **Language:** English (`en`) — matches `WHATSAPP_TEMPLATE_LANG`.
- Placeholders `{{1}}`, `{{2}}`… are filled by the backend in the order shown.
- Param values must be single-line (no newlines/tabs) — the code already
  formats them that way.

When a template's env var is **unset**, the backend falls back to a free-form
message (delivers only inside the 24h window). So nothing breaks before approval;
the templates just extend reach.

---

## 1. `order_ready_pickup` — READY FOR COLLECTION  ✅ already approved & live

Env: `WHATSAPP_TEMPLATE_PICKUP` (currently `order_ready_pickup`).
Params: `{{1}}` first name · `{{2}}` order number · `{{3}}` business hours ·
`{{4}}` location (the backend now appends the directions link here, e.g.
`Fusion Prints Lab, 53G3+M5 Harare — Directions: https://maps.google.com/...`).

**Body (for reference — keep your approved version):**
```
✅ Hi {{1}}, your order {{2}} is ready to collect!

Pick up during business hours ({{3}}).

📍 {{4}}

At the counter, just give your name or order number.
```
> The Google Maps "Navigate" link rides inside `{{4}}`, so it appears **inside
> this message** (tappable) — no template change needed. If you'd prefer a
> dedicated **"🧭 Navigate" URL button** instead of inline text, that's a v2
> template with a *Buttons → URL (dynamic)* component; tell me and I'll wire the
> button param.

---

## 2. `order_out_for_delivery` — OUT FOR DELIVERY  🆕 submit this

Env to set after approval: **`WHATSAPP_TEMPLATE_DELIVERY`**.
Params: `{{1}}` first name · `{{2}}` order number · `{{3}}` business name.

**Body — submit exactly this:**
```
🚚 Hi {{1}}, your order {{2}} is on its way!

Your prints have left {{3}} and are out for delivery — our driver will be in touch shortly.

Questions? Just reply to this message.
```
**Sample values (for the approval form):** `{{1}}=Tinashe`, `{{2}}=FP-2026-0042`,
`{{3}}=FusionPrints Lab`.

---

## 3. `order_fulfilled` — COLLECTED / DELIVERED thank-you  🆕 submit this

Env to set after approval: **`WHATSAPP_TEMPLATE_FULFILLED`**.
Params: `{{1}}` first name · `{{2}}` order number · `{{3}}` business name.

**Body — submit exactly this:**
```
🎉 Thank you, {{1}}! Order {{2}} is complete.

Thanks for printing with {{3}} — we'd love to print for you again. Just send a photo whenever you're ready. 💚
```
**Sample values:** `{{1}}=Tinashe`, `{{2}}=FP-2026-0042`, `{{3}}=FusionPrints Lab`.

---

## After approval — wiring (per template)

1. Copy the **approved template name** from 360dialog.
2. Set the env var on prod (`.env`):
   - `WHATSAPP_TEMPLATE_DELIVERY=order_out_for_delivery`
   - `WHATSAPP_TEMPLATE_FULFILLED=order_fulfilled`
3. Restart the backend (`sudo systemctl restart fusionprints`, or redeploy).

The backend already reads these vars (`config/env.ts`) and uses the template when
set — `services/order.ts` `sendOutForDeliveryNotification` / `notifyOrderFulfilled`
/ `sendReadyForPickupNotification`. Param order above matches the code exactly.
