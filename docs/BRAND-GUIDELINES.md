# FusionPrints — Brand System

> **Hold the moment.**

A photo printing service that turns digital images into physical prints. Sister brand to Innovative Fusions.

---

## Tone

**Accessible · Modern · Warm**

We talk like a thoughtful person, not a corporate brochure. Photos people print are often emotional — weddings, graduations, memorial photos. We never sound flippant. We never sound cold either.

✓ "Your prints are ready."
✗ "Print order #FP-2026-0042 has reached fulfilment status."

✓ "We'll let you know when these are done."
✗ "Notification will be dispatched upon completion."

---

## Logo

The mark is a stylized photo album corner — the geometric tab where a print used to mount into an album page. The malachite green wedge represents the photo itself emerging from the corner.

### Files
| File | Use |
|---|---|
| `logo-full-color.svg` | Default — light backgrounds |
| `logo-full-on-dark.svg` | Dark backgrounds |
| `logo-full-mono-black.svg` | Single-color print, stamps, faxes |
| `mark-only-color.svg` | Favicon, watermarks, very small spaces |
| `app-icon-512.svg` | iOS / Android app icon, social profile pic |
| `logo-with-parent.svg` | Footer of website, About page |

### Sizing
- **Minimum width:** 120px (full lockup) / 32px (mark only)
- **Clear space:** Allow at least the height of the photo-corner mark on all sides
- **Always proportional** — never stretch or squash

### What not to do
- Don't change colors outside the palette
- Don't swap the typography
- Don't add a drop shadow, gradient, or glow
- Don't outline it
- Don't put it on a busy photo without contrast (use a solid backdrop)

---

## Color palette

The Sunlit palette. Cream paper, deep ink, malachite green from the parent, sunset coral as the emotional accent.

| Color | Hex | Use |
|---|---|---|
| Cream | `#FBF7F0` | Primary background |
| Cream warm | `#F4ECDD` | Secondary surfaces, cards |
| Ink | `#1F1B16` | Primary text, dark elements |
| Ink soft | `#4A3F32` | Body text |
| Ink mute | `#8A7B66` | Muted text, captions |
| Malachite | `#05D668` | Brand accent — buttons, badges, status (parent DNA) |
| Malachite deep | `#04A551` | Hover states for malachite elements |
| Coral | `#FF7A59` | Emotional accent — highlight words, key callouts |
| Amber | `#EFAB11` | Tertiary accent — sparingly |
| Paper | `#FFFFFF` | Cards floating on cream backgrounds |

### Usage rules
- **Cream is the dominant background.** Not pure white.
- **Malachite is for action.** Buttons, "Done" states, brand confirmations.
- **Coral is for emotion.** Use sparingly to highlight 1-2 words per surface.
- **Don't use coral as a button color.** It's a warm accent, not a CTA.

---

## Typography

| Font | Use | Source |
|---|---|---|
| **Fraunces** | Display headlines, italic emphasis | Google Fonts (free) |
| **Outfit** | Body text, buttons, UI labels | Google Fonts (free) |
| **DM Mono** | Order numbers, technical accents, microcopy | Google Fonts (free) |

### Type system
- **Display headline:** Fraunces, 500 weight, italic for emotional words ("beautifully")
- **Body:** Outfit, 400 weight, line-height 1.5
- **UI labels:** Outfit, 500 weight
- **Eyebrow / category labels:** DM Mono, uppercase, letter-spacing 0.12em
- **Mono accents:** DM Mono for order numbers, codes, timestamps

### Loading
```html
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
```

---

## Voice

### Tagline
**Hold the moment.**

Use:
- Website hero
- Receipt footers
- Social bios
- Email signatures

Don't ever modify, translate, or expand it.

### Microcopy patterns
- Use first person plural ("we") — we're a small team caring about this together
- Use second person ("you", "your") — speak directly to the customer
- Sentence case for buttons, never ALL CAPS
- Avoid "click here" / "tap here" — use action verbs ("Continue", "Send photos")
- Periods only when there are multiple sentences

✓ "We'll let you know when your prints are ready"
✗ "Click here to be notified upon order completion."

---

## Parent attribution

FusionPrints is a venture by Innovative Fusions PVT Ltd. The connection appears as a quiet trust signal:

- **Footer of website:** Small "A venture by Innovative Fusions" text
- **About page:** One sentence acknowledging the parent
- **Receipts:** Below the line, small print

Do **not** put the Innovative Fusions logo prominently on FusionPrints surfaces. The brands are siblings, not parent/child.

---

## Customer-facing surfaces (status)

| Surface | Status |
|---|---|
| Web upload page | ✓ Designed (Sunlit) |
| WhatsApp profile picture | 🔲 Use `app-icon-512.svg` |
| Receipt template | 🔲 To build |
| Marketing site (`fusionprints.co.zw`) | 🔲 To build |
| Email templates | 🔲 To build |
| Print labels / packaging | 🔲 To build |

---

*Last updated: 2026-05-01*
