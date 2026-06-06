/**
 * Admin Login Routes
 *
 * Provides session-based authentication for the admin panel.
 *
 * Routes:
 *   GET  /admin/login     — styled Sunlit login page
 *   POST /admin/login     — validate credentials, set session, return JSON
 *   GET  /admin/logout    — destroy session, redirect to /admin/login
 *   GET  /admin/autologin — validate Beelink token, set session, redirect to /admin
 */

import type { FastifyInstance } from 'fastify';
import { validateCredentials, validateAutologinToken } from '@/utils/auth.js';
import { logger } from '@/utils/logger.js';
import { ADMIN_FONT_CSS } from '@/routes/admin-fonts.js';

function loginPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — FusionPrints Admin</title>
  <style>
    ${ADMIN_FONT_CSS}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #FBF7F0;
      color: #1F1B16;
      font-family: 'Outfit', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #FFFFFF;
      border: 1px solid #E5DDD4;
      border-radius: 16px;
      padding: 48px 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 4px 32px rgba(31,27,22,0.07);
    }
    .logo { margin-bottom: 36px; }
    h1 {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 30px;
      font-weight: 700;
      color: #1F1B16;
      margin-bottom: 6px;
      letter-spacing: -0.5px;
    }
    .subtitle {
      color: #8A7D6E;
      font-size: 14px;
      margin-bottom: 28px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #1F1B16;
      margin-bottom: 6px;
      margin-top: 16px;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid #DDD5C8;
      border-radius: 8px;
      font-family: 'Outfit', system-ui, sans-serif;
      font-size: 15px;
      color: #1F1B16;
      background: #FDFAF6;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input[type="text"]:focus,
    input[type="password"]:focus {
      border-color: #05D668;
      box-shadow: 0 0 0 3px rgba(5,214,104,0.12);
      background: #fff;
    }
    button[type="submit"] {
      width: 100%;
      padding: 13px;
      margin-top: 24px;
      background: #05D668;
      color: #1F1B16;
      border: none;
      border-radius: 8px;
      font-family: 'Outfit', system-ui, sans-serif;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }
    button[type="submit"]:hover { opacity: 0.87; }
    button[type="submit"]:active { transform: scale(0.99); opacity: 0.75; }
    button[type="submit"]:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .error {
      background: #FFF3F0;
      border: 1px solid #FF7A59;
      border-radius: 8px;
      padding: 11px 14px;
      color: #C0341C;
      font-size: 13px;
      margin-top: 16px;
      display: none;
      align-items: center;
      gap: 8px;
    }
    .footer {
      margin-top: 28px;
      text-align: center;
      font-size: 12px;
      color: #B8AC9E;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg viewBox="0 0 200 44" xmlns="http://www.w3.org/2000/svg" style="height:32px;width:auto;" aria-label="FusionPrints">
        <g transform="translate(0,4)">
          <path d="M0 6 L9 0 L30 0 L30 10.5 L19.5 10.5 L10.5 16.5 L10.5 36 L0 36 Z" fill="#1F1B16"/>
          <path d="M10.5 16.5 L19.5 10.5 L30 10.5 L30 21 Z" fill="#05D668"/>
        </g>
        <text x="40" y="30" font-family="Outfit, system-ui, sans-serif" font-size="21" font-weight="700" fill="#1F1B16" letter-spacing="-0.4">fusionprints</text>
      </svg>
    </div>

    <h1>Welcome back</h1>
    <p class="subtitle">Sign in to the admin panel</p>

    <div id="error-box" class="error">
      <span>&#9888;</span>
      <span id="error-msg"></span>
    </div>

    <label for="username">Username</label>
    <input type="text" id="username" name="username" autocomplete="username" autofocus />

    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" />

    <button type="submit" id="submit-btn" onclick="handleLogin()">Sign in</button>

    <p class="footer">FusionPrints &mdash; Hold the moment.</p>
  </div>

  <script>
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleLogin();
    });

    async function handleLogin() {
      var username = document.getElementById('username').value.trim();
      var password = document.getElementById('password').value;
      var btn = document.getElementById('submit-btn');
      var errorBox = document.getElementById('error-box');
      var errorMsg = document.getElementById('error-msg');

      if (!username || !password) {
        errorMsg.textContent = 'Please enter your username and password.';
        errorBox.style.display = 'flex';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Signing in\u2026';
      errorBox.style.display = 'none';

      try {
        var res = await fetch('/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username, password: password }),
        });
        var data = await res.json();

        if (res.ok && data.ok) {
          window.location.href = '/admin';
        } else {
          errorMsg.textContent = data.message || 'Wrong username or password.';
          errorBox.style.display = 'flex';
          btn.disabled = false;
          btn.textContent = 'Sign in';
          document.getElementById('password').value = '';
          document.getElementById('password').focus();
        }
      } catch (e) {
        errorMsg.textContent = 'Connection error. Please try again.';
        errorBox.style.display = 'flex';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    }
  </script>
</body>
</html>`;
}

export async function registerAdminLogin(app: FastifyInstance): Promise<void> {

  // Login page — redirect to /admin if already authenticated
  app.get('/admin/login', async (request, reply) => {
    const role = (request as any).session?.role as string | undefined;
    if (role) return reply.redirect('/admin');
    return reply.type('text/html').send(loginPageHtml());
  });

  // Login POST — accepts JSON, returns JSON
  app.post('/admin/login', async (request, reply) => {
    const { username, password } = request.body as { username?: string; password?: string };

    if (!username || !password) {
      return reply
        .status(400)
        .send({ ok: false, message: 'Username and password required.' });
    }

    const role = validateCredentials(username, password);
    if (!role) {
      logger.warn({ username }, 'Failed admin login attempt');
      return reply
        .status(401)
        .send({ ok: false, message: 'Wrong username or password.' });
    }

    (request as any).session.role = role;
    logger.info({ username, role }, 'Admin login successful');
    return { ok: true, role };
  });

  // Logout — destroy session, go back to login page
  app.get('/admin/logout', async (request, reply) => {
    await (request as any).session.destroy();
    return reply.redirect('/admin/login');
  });

  // Autologin — Beelink Chrome shortcut
  // GET /admin/autologin?token=<BEELINK_AUTOLOGIN_TOKEN>
  // Validates token, sets session, redirects to dashboard.
  // Falls back to login page on any failure.
  app.get('/admin/autologin', async (request, reply) => {
    const { token } = request.query as { token?: string };

    if (!token) return reply.redirect('/admin/login');

    const role = validateAutologinToken(token);
    if (!role) {
      logger.warn('Invalid or missing autologin token attempt');
      return reply.redirect('/admin/login');
    }

    // Autologin is always operator role — Beelink is Tobias's machine
    (request as any).session.role = 'operator';
    logger.info({ role }, 'Beelink autologin successful');
    return reply.redirect('/admin');
  });
}
