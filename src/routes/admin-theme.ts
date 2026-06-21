/**
 * Shared admin/operator theme + page shell.
 *
 * Every admin page used to define its own <style> block and its own (or no)
 * navigation, so the surface drifted: admin-ops went dark (#0a0a0a/orange) while
 * the login page stayed on-brand, and pricing/locations/promos each invented a
 * third dark palette with only a lone "← Admin" back-link. This module is the
 * single home for the look: import ADMIN_THEME_CSS for the styles and wrap page
 * bodies in adminShell() for consistent brand chrome (header + full nav).
 *
 * Palette is the FusionPrints brand (same tokens as the customer site + emails):
 * cream #FBF7F0, ink #1F1B16, malachite #05D668. Every CSS custom property that
 * any admin page references is declared here, so inline blocks that read
 * var(--surface) / var(--text) / var(--mute) etc. re-theme automatically.
 */
import { BRAND_FONT_CSS } from '@/routes/admin-fonts.js';
import type { AdminRole } from '@/utils/auth.js';

/**
 * Brand theme: :root tokens (a superset of every var used across admin pages) +
 * base typography + the shared component library (header/nav, cards, buttons,
 * tables, inputs, notices, status badges, modal). Inject into a page's <style>.
 */
export const ADMIN_THEME_CSS = `
${BRAND_FONT_CSS}

:root {
  /* Brand surfaces */
  --bg: #FBF7F0;          /* cream page */
  --surface: #FFFFFF;     /* cards / tables */
  --surface2: #F5EFE4;    /* inputs / raised rows */
  --border: #E7DED0;      /* hairlines */
  --line: #E7DED0;
  /* Text */
  --text: #1F1B16;        /* ink — headings + primary */
  --text2: #8A7B66;       /* muted — labels + secondary */
  --mute: #8A7B66;
  /* Accents (tuned for contrast on a light background) */
  --accent: #05D668;      /* malachite — primary action */
  --accent-deep: #04A551; /* malachite for text/links on light */
  --green: #04A551;
  --red: #C0392B;
  --danger: #C0392B;
  --amber: #B8730B;
  --blue: #2563EB;
  --radius: 8px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Outfit', 'DM Sans', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent-deep); }

/* ---- Header + navigation ---- */
header {
  display: flex;
  align-items: center;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.logo { display: inline-flex; align-items: center; gap: 10px; }
.logo svg { display: block; height: 34px; width: auto; }
.logo .admin-tag {
  font-family: 'DM Mono', monospace;
  font-size: 10px;
  font-weight: 500;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.nav-tabs { display: flex; gap: 2px; flex: 1; margin-left: 24px; flex-wrap: wrap; }
.nav-tab {
  padding: 8px 14px;
  color: var(--text2);
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
  border-radius: 8px;
  transition: all 0.15s;
}
.nav-tab:hover { color: var(--text); background: var(--bg); }
.nav-tab.active { color: var(--text); background: var(--surface2); }
.nav-logout { margin-left: auto; }

main { padding: 28px 24px; max-width: 1400px; margin: 0 auto; }

/* ---- Headings / page intro ---- */
.page-header { margin-bottom: 22px; }
.page-title, h1 { font-family: 'Fraunces', Georgia, serif; font-size: 26px; font-weight: 600; line-height: 1.2; }
.page-sub, .sub { color: var(--text2); font-size: 14px; margin-top: 4px; }
h2 { font-size: 13px; color: var(--text2); text-transform: uppercase; letter-spacing: .05em; margin: 24px 0 10px; font-weight: 700; }

/* ---- Cards ---- */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
}

/* ---- Buttons ---- */
.btn {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 9px 16px;
  border-radius: 999px;
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  transition: all 0.15s;
}
.btn:hover { border-color: var(--accent-deep); color: var(--accent-deep); }
.btn-primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: #0a3d22; }
.btn-primary:hover, .btn.primary:hover { opacity: 0.9; color: #0a3d22; }
.btn-danger, .btn.danger, .btn.del { background: transparent; border-color: var(--danger); color: var(--danger); }
.btn-danger:hover, .btn.danger:hover, .btn.del:hover { background: var(--danger); color: #fff; }

/* ---- Forms ---- */
input[type=text], input[type=password], input[type=number], input[type=email], input:not([type]), select, textarea {
  padding: 9px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(5,214,104,0.15); }

/* ---- Tables ---- */
table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
th { color: var(--text2); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }

/* ---- Notices ---- */
.notice { background: var(--accent); color: #0a3d22; padding: 11px 15px; border-radius: 10px; margin-bottom: 16px; font-weight: 600; }

/* ---- Status badges (light-background tints) ---- */
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; text-transform: capitalize; }
.badge-pending_payment { background: #F1ECE3; color: #8A7B66; border: 1px solid #E7DED0; }
.badge-paid { background: #E3F7EC; color: #04A551; border: 1px solid #A7E8C4; }
.badge-awaiting_approval { background: #FCEFD9; color: #B8730B; border: 1px solid #F0D9A8; }
.badge-queued_for_print { background: #E3EEFB; color: #2563EB; border: 1px solid #BBD4F5; }
.badge-printing { background: #E3EEFB; color: #2563EB; border: 1px solid #BBD4F5; }
.badge-printed { background: #FBF1D9; color: #9A6B0B; border: 1px solid #F0DDA8; }
.badge-ready_for_pickup, .badge-ready_for_collection { background: #E3F7EC; color: #04A551; border: 1px solid #A7E8C4; }
.badge-fulfilled, .badge-cancelled { background: #F1ECE3; color: #8A7B66; border: 1px solid #E7DED0; }
.badge-failed { background: #FBE6E2; color: #C0392B; border: 1px solid #F2C4BB; }

/* ---- Misc ---- */
.loading, .empty { color: var(--text2); padding: 24px; text-align: center; font-size: 14px; }
.muted { color: var(--text2); font-size: 14px; }
.mono { font-family: 'DM Mono', monospace; }

.logo { text-decoration: none; }            /* it's an <a> home link */

/* ---- Mobile nav ---- */
.hamburger { display: none; background: none; border: 1px solid var(--border); color: var(--text); padding: 6px 11px; border-radius: 8px; cursor: pointer; font-size: 20px; line-height: 1; }
.mobile-nav { display: none; position: fixed; top: 56px; left: 0; right: 0; background: var(--surface); border-bottom: 1px solid var(--border); z-index: 999; padding: 6px 0; box-shadow: 0 10px 28px rgba(31,27,22,0.16); max-height: calc(100vh - 56px); overflow-y: auto; }
.mobile-nav.open { display: block; }
.mobile-nav a { display: block; padding: 14px 20px; color: var(--text2); text-decoration: none; font-size: 16px; font-weight: 600; border-bottom: 1px solid var(--border); }
.mobile-nav a:last-child { border-bottom: none; }
.mobile-nav a.active, .mobile-nav a:hover { background: var(--surface2); color: var(--text); }

/* ---- Responsive helpers + wide-table scroll ---- */
.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }

@media (max-width: 820px) {
  header { position: sticky; top: 0; z-index: 1000; }
  .logo svg { height: 28px; }
  .page-title, h1 { font-size: 22px; }
  .card { padding: 16px; border-radius: 10px; }
  main table { font-size: 13px; }
  th, td { padding: 9px 10px; }
}
@media (max-width: 768px) {
  .nav-tabs { display: none !important; }
  .hamburger { display: block; }
  /* nav-tabs (the flex spacer) is gone on mobile, so push the logo + hamburger
     to opposite ends instead of letting them bunch together on the left. */
  header { padding: 10px 14px; justify-content: space-between; }
  main { padding: 14px 12px; }
  .btn, .action-btn { padding: 8px 14px; }   /* easier tap targets */
}
`;

/** Brand wordmark SVG, tuned for a light background (ink wordmark, malachite mark). */
export function adminLogoSvg(): string {
  return `<svg viewBox="0 0 280 60" xmlns="http://www.w3.org/2000/svg" aria-label="FusionPrints">
        <g transform="translate(0,6)">
          <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="#1F1B16"/>
          <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="#05D668"/>
        </g>
        <text x="56" y="40" font-family="Outfit, system-ui, -apple-system, sans-serif" font-size="28" font-weight="700" fill="#1F1B16" letter-spacing="-0.56">fusionprints</text>
      </svg>`;
}

export type AdminNavKey = 'orders' | 'metrics' | 'printers' | 'jobs' | 'promos' | 'pricing' | 'locations' | 'qbo';

/** Header + nav markup. Operators see only Order Management + Printers. */
function adminHeader(active: AdminNavKey, role: AdminRole): string {
  const isOperator = role === 'operator';
  const tab = (href: string, key: AdminNavKey, label: string) =>
    `<a href="${href}" class="nav-tab ${active === key ? 'active' : ''}">${label}</a>`;
  return `<header>
    <a class="logo" href="/admin" aria-label="FusionPrints Admin home">
      ${adminLogoSvg()}
      <span class="admin-tag">${isOperator ? 'operator' : 'admin'}</span>
    </a>
    <nav class="nav-tabs">
      ${tab('/admin/jobs', 'jobs', 'Order Management')}
      ${tab('/admin/printers', 'printers', 'Printers and Configuration')}
      ${isOperator ? '' : tab('/admin/metrics', 'metrics', 'Key Metrics')}
      ${isOperator ? '' : tab('/admin/promos', 'promos', 'Promos')}
      ${isOperator ? '' : tab('/admin/pricing', 'pricing', 'Pricing')}
      ${isOperator ? '' : tab('/admin/locations', 'locations', 'Locations')}
      ${isOperator ? '' : tab('/admin/qbo', 'qbo', 'QuickBooks')}
      <a href="/admin/logout" class="nav-tab nav-logout">Logout</a>
    </nav>
    <button class="hamburger" id="hamburger-btn" onclick="toggleMobileNav()">&#9776;</button>
  </header>
  <div class="mobile-nav" id="mobile-nav">
    <a href="/admin/jobs" class="${active === 'jobs' ? 'active' : ''}">Order Management</a>
    <a href="/admin/printers" class="${active === 'printers' ? 'active' : ''}">Printers and Configuration</a>
    ${isOperator ? '' : `<a href="/admin/metrics" class="${active === 'metrics' ? 'active' : ''}">Key Metrics</a>`}
    ${isOperator ? '' : `<a href="/admin/promos" class="${active === 'promos' ? 'active' : ''}">Promos</a>`}
    ${isOperator ? '' : `<a href="/admin/pricing" class="${active === 'pricing' ? 'active' : ''}">Pricing</a>`}
    ${isOperator ? '' : `<a href="/admin/locations" class="${active === 'locations' ? 'active' : ''}">Locations</a>`}
    ${isOperator ? '' : '<a href="/admin/qbo">QuickBooks</a>'}
    <a href="/admin/logout">Logout</a>
  </div>
  <script>
    function toggleMobileNav() { document.getElementById('mobile-nav').classList.toggle('open'); }
    document.addEventListener('click', function(e) {
      var nav = document.getElementById('mobile-nav'), btn = document.getElementById('hamburger-btn');
      if (nav && btn && !nav.contains(e.target) && !btn.contains(e.target)) nav.classList.remove('open');
    });
  </script>`;
}

/**
 * Full branded page: <!DOCTYPE> + theme + header/nav + <main>{body}</main>.
 * `extraCss` is appended inside the <style> for page-specific rules.
 */
export function adminShell(opts: {
  active: AdminNavKey;
  title: string;
  body: string;
  role?: AdminRole;
  extraCss?: string;
}): string {
  const { active, title, body, role = 'full', extraCss = '' } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FusionPrints Admin — ${title}</title>
  <link rel="icon" type="image/svg+xml" href="/admin/favicon.svg">
  <style>${ADMIN_THEME_CSS}${extraCss}</style>
</head>
<body>
  ${adminHeader(active, role)}
  <main>${body}</main>
</body>
</html>`;
}
