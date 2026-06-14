/**
 * Web Upload Routes
 *
 * Provides a browser-based upload experience for customers who want to
 * upload many photos at once. Much faster than WhatsApp document uploads
 * because the browser uploads files in parallel.
 *
 * Routes:
 *   GET  /u/:token              — upload page (HTML)
 *   POST /api/upload/:token     — receive an uploaded file (multipart)
 *   GET  /api/upload/:token/status — get session status (poll-friendly)
 *
 * Flow:
 *   1. Bot creates upload session, gives customer link with token
 *   2. Customer opens link in browser, drag-drops files
 *   3. Each file uploads to /api/upload/:token via multipart
 *   4. We store in B2 and create image record linked to customer
 *   5. Customer types UPLOADED in WhatsApp
 *   6. Bot pulls all images from this session into the cart
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { eq, and, gte, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db } from '@/db/client.js';
import { uploadSessions, images } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { storeImage } from '@/services/image-storage.js';
import { BRAND_FONT_CSS } from '@/routes/admin-fonts.js';
import { env } from '@/config/env.js';

// Per-session upload caps. The multipart `files` limit only bounds one request,
// and the page posts one file per request — these bound the whole session.
const MAX_SESSION_FILES = 200;
const MAX_SESSION_BYTES = 500 * 1024 * 1024; // 500MB

// ===== Helpers =====

/** Generate a short URL-safe token */
export function generateUploadToken(): string {
  return randomBytes(8).toString('hex'); // 16 chars, e.g. "a3f9d8e72b1c4d50"
}

/** Create a new upload session for a customer */
export async function createUploadSession(
  customerId: string,
  sizeCode: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateUploadToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(uploadSessions).values({
    customerId,
    token,
    sizeCode,
    expiresAt,
  });

  return { token, expiresAt };
}

/** Get session by token, returns null if not found or expired */
async function getSession(token: string) {
  const [session] = await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.token, token),
        gte(uploadSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

// ===== Upload page HTML =====

// ===== Upload page HTML =====

function uploadPageHtml(token: string, sizeCode: string, businessPhone: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upload your photos · FusionPrints</title>
  <style>
    ${BRAND_FONT_CSS}
    :root {
      --bg: #FBF7F0;
      --bg-2: #F4ECDD;
      --ink: #1F1B16;
      --ink-soft: #4A3F32;
      --ink-mute: #8A7B66;
      --line: rgba(31, 27, 22, 0.10);
      --line-soft: rgba(31, 27, 22, 0.06);
      --malachite: #05D668;
      --malachite-deep: #04A551;
      --coral: #FF7A59;
      --amber: #EFAB11;
      --paper: #FFFFFF;
      --shadow-soft: 0 1px 3px rgba(31, 27, 22, 0.04), 0 8px 24px rgba(31, 27, 22, 0.04);
      --shadow-warm: 0 2px 8px rgba(255, 122, 89, 0.08), 0 16px 40px rgba(31, 27, 22, 0.08);
      --red: #C0392B;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: var(--bg);
      color: var(--ink);
      font-family: 'Outfit', -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }

    /* Subtle paper-grain ambience */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        radial-gradient(circle at 20% 30%, rgba(239, 171, 17, 0.04) 0%, transparent 50%),
        radial-gradient(circle at 80% 70%, rgba(255, 122, 89, 0.04) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .page {
      position: relative;
      z-index: 1;
      max-width: 720px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }

    /* Header */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 36px;
    }
    .brand-logo { display: flex; align-items: center; gap: 0; }
    .brand-logo svg { display: block; }
    .session-tag {
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      color: var(--ink-mute);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    /* Hero */
    .hero { margin-bottom: 32px; }
    .hero-eyebrow {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--malachite-deep);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 12px;
    }
    .hero-title {
      font-family: 'Fraunces', serif;
      font-size: clamp(34px, 7vw, 48px);
      font-weight: 500;
      line-height: 1.05;
      letter-spacing: -0.02em;
      color: var(--ink);
      margin-bottom: 14px;
    }
    .hero-title em {
      font-style: italic;
      color: var(--coral);
      font-weight: 400;
    }
    .hero-sub {
      font-size: 17px;
      color: var(--ink-soft);
      line-height: 1.5;
      max-width: 480px;
    }

    /* Order card */
    .order-card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .order-icon {
      width: 44px;
      height: 44px;
      background: var(--bg-2);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }
    .order-meta { flex: 1; min-width: 0; }
    .order-meta-label {
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      color: var(--ink-mute);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 2px;
    }
    .order-meta-value {
      font-family: 'Fraunces', serif;
      font-size: 19px;
      font-weight: 500;
      color: var(--ink);
    }

    /* Drop zone */
    .drop-zone {
      background: var(--paper);
      border: 2px dashed rgba(5, 214, 104, 0.35);
      border-radius: 18px;
      padding: 44px 20px;
      text-align: center;
      transition: all 0.2s ease;
      cursor: pointer;
      margin-bottom: 24px;
    }
    .drop-zone:hover, .drop-zone.dragging {
      border-color: var(--malachite-deep);
      background: linear-gradient(180deg, var(--paper) 0%, rgba(5, 214, 104, 0.03) 100%);
    }
    .drop-icon-wrap {
      width: 60px;
      height: 60px;
      margin: 0 auto 16px;
      background: linear-gradient(135deg, var(--malachite) 0%, var(--malachite-deep) 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 24px rgba(5, 214, 104, 0.22);
    }
    .drop-icon-wrap svg { width: 28px; height: 28px; color: white; }
    .drop-title {
      font-family: 'Fraunces', serif;
      font-size: 22px;
      font-weight: 500;
      color: var(--ink);
      margin-bottom: 4px;
    }
    .drop-sub {
      font-size: 15px;
      color: var(--ink-soft);
      margin-bottom: 16px;
    }
    .drop-button {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--ink);
      color: var(--bg);
      border: none;
      padding: 13px 24px;
      border-radius: 999px;
      font-family: 'Outfit', sans-serif;
      font-weight: 500;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .drop-button:hover { transform: translateY(-1px); box-shadow: var(--shadow-warm); }
    input[type="file"] { display: none; }

    /* Files list */
    .files-section { margin-bottom: 24px; }
    .files-section.hidden { display: none; }
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .section-title {
      font-family: 'Fraunces', serif;
      font-size: 19px;
      font-weight: 500;
      color: var(--ink);
    }
    .section-count {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--ink-mute);
    }

    .file-item {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 8px;
      display: grid;
      grid-template-columns: 32px 1fr auto;
      align-items: center;
      gap: 12px;
    }
    .file-icon {
      width: 32px;
      height: 32px;
      background: var(--bg-2);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .file-info { min-width: 0; }
    .file-name {
      font-size: 15px;
      font-weight: 500;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-size {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--ink-mute);
      margin-top: 2px;
    }
    .progress-bar {
      grid-column: 1 / -1;
      width: 100%;
      height: 3px;
      background: var(--bg-2);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-fill {
      height: 100%;
      width: 0;
      background: var(--malachite);
      border-radius: 2px;
      transition: width 0.2s ease;
    }
    .file-status {
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      letter-spacing: 0.04em;
    }
    .file-status.uploading { color: var(--ink-mute); }
    .file-status.done { color: var(--malachite-deep); }
    .file-status.error { color: var(--red); }

    /* Progress summary */
    .progress-summary {
      display: none;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 24px;
      font-size: 16px;
      color: var(--ink-soft);
    }
    .progress-summary .progress-count {
      font-family: 'DM Mono', monospace;
      font-weight: 500;
      color: var(--ink);
    }

    /* Final summary / Done CTA */
    .summary {
      display: none;
      background: var(--ink);
      border-radius: 16px;
      padding: 22px;
      color: var(--bg);
      box-shadow: 0 16px 40px rgba(31, 27, 22, 0.16);
      margin-bottom: 24px;
    }
    .summary-meta {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--malachite);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 6px;
    }
    .summary-title {
      font-family: 'Fraunces', serif;
      font-size: 26px;
      font-weight: 500;
      color: var(--bg);
      margin-bottom: 8px;
    }
    .summary-text {
      font-size: 16px;
      color: rgba(251, 247, 240, 0.8);
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .whatsapp-cta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--malachite);
      color: var(--ink);
      border: none;
      padding: 14px 26px;
      border-radius: 999px;
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 16px;
      cursor: pointer;
      text-decoration: none;
      transition: transform 0.15s ease;
    }
    .whatsapp-cta:hover { transform: translateX(2px); }

    /* Footer */
    .footer-note {
      text-align: center;
      margin-top: 32px;
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--ink-mute);
      letter-spacing: 0.04em;
    }
    .footer-note a {
      color: var(--ink-soft);
      text-decoration: none;
      border-bottom: 1px solid var(--line);
    }
    .footer-tagline {
      font-family: 'Fraunces', serif;
      font-style: italic;
      font-size: 15px;
      color: var(--ink-soft);
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="brand-logo">
        <svg width="240" height="52" viewBox="0 0 280 60" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(0,6)">
            <path d="M0 8 L12 0 L40 0 L40 14 L26 14 L14 22 L14 48 L0 48 Z" fill="#1F1B16"/>
            <path d="M14 22 L26 14 L40 14 L40 28 Z" fill="#05D668"/>
          </g>
          <text x="56" y="40" font-family="Outfit, sans-serif" font-size="28" font-weight="700" fill="#1F1B16" letter-spacing="-0.56">fusionprints</text>
        </svg>
      </div>
      <span class="session-tag">${token.slice(0, 8)}</span>
    </header>

    <section class="hero">
      <div class="hero-eyebrow">Upload your photos</div>
      <h1 class="hero-title">Send your photos,<br>we'll do the <em>rest</em>.</h1>
      <p class="hero-sub">Drop your photos below. We'll let you know in WhatsApp once you're ready to continue.</p>
    </section>

    <div class="order-card">
      <div class="order-icon">📷</div>
      <div class="order-meta">
        <div class="order-meta-label">Order</div>
        <div class="order-meta-value">${sizeCode} · multi-photo upload</div>
      </div>
    </div>

    <div class="drop-zone" id="drop-zone">
      <div class="drop-icon-wrap">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
        </svg>
      </div>
      <div class="drop-title">Drop photos here</div>
      <div class="drop-sub">or tap to choose from your phone</div>
      <button class="drop-button">
        Choose photos
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
      <input type="file" id="file-input" accept="image/*" multiple>
    </div>

    <div class="progress-summary" id="progress-summary">
      Uploading <span class="progress-count" id="progress-count">0 / 0</span>...
    </div>

    <section class="files-section" id="files-section">
      <div class="section-head">
        <h2 class="section-title">Your photos</h2>
      </div>
      <div id="files-list"></div>
    </section>

    <div class="summary" id="summary">
      <div class="summary-meta">↳ Done?</div>
      <div class="summary-title" id="summary-title"></div>
      <div class="summary-text" id="summary-text"></div>
      <a class="whatsapp-cta" id="whatsapp-cta" href="#">
        Return to WhatsApp
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>
    </div>

    <div class="footer-note">
      <div class="footer-tagline">Hold the moment.</div>
    </div>
  </div>

  <script>
    const TOKEN = '${token}';
    const BUSINESS_PHONE = '${businessPhone}';
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const filesList = document.getElementById('files-list');
    const summary = document.getElementById('summary');
    const progressSummary = document.getElementById('progress-summary');
    const progressCount = document.getElementById('progress-count');
    const whatsappCta = document.getElementById('whatsapp-cta');

    let totalFiles = 0;
    let uploadedFiles = 0;
    let failedFiles = 0;

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragging');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragging');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragging');
      handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
    });

    function formatSize(bytes) {
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function handleFiles(files) {
      Array.from(files).forEach((file) => {
        if (!file.type.startsWith('image/')) return;
        totalFiles++;
        uploadFile(file);
      });
      updateProgressSummary();
    }

    function updateProgressSummary() {
      const completed = uploadedFiles + failedFiles;
      if (totalFiles > 0 && completed < totalFiles) {
        progressSummary.style.display = 'block';
        progressCount.textContent = completed + ' / ' + totalFiles;
        summary.style.display = 'none';
      }
    }

    async function uploadFile(file) {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = \`
        <span class="file-icon">📷</span>
        <div class="file-info">
          <div class="file-name">\${file.name}</div>
          <div class="file-size">\${formatSize(file.size)}</div>
        </div>
        <div class="file-status uploading">uploading…</div>
        <div class="progress-bar"><div class="progress-fill"></div></div>
      \`;
      filesList.appendChild(item);

      const progressFill = item.querySelector('.progress-fill');
      const status = item.querySelector('.file-status');

      const formData = new FormData();
      formData.append('file', file);

      try {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const pct = (e.loaded / e.total) * 100;
            progressFill.style.width = pct + '%';
          }
        });

        await new Promise((resolve, reject) => {
          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error('Upload failed: ' + xhr.status));
          });
          xhr.addEventListener('error', () => reject(new Error('Network error')));
          xhr.open('POST', '/api/upload/' + TOKEN);
          xhr.send(formData);
        });

        progressFill.style.width = '100%';
        status.textContent = 'done ✓';
        status.className = 'file-status done';
        uploadedFiles++;
      } catch (err) {
        status.textContent = 'failed';
        status.className = 'file-status error';
        failedFiles++;
        console.error('Upload error:', err);
      }

      updateProgressSummary();
      checkComplete();
    }

    function checkComplete() {
      if (uploadedFiles + failedFiles === totalFiles && totalFiles > 0) {
        progressSummary.style.display = 'none';
        summary.style.display = 'block';

        if (failedFiles === 0) {
          document.getElementById('summary-title').textContent =
            \`\${uploadedFiles} photo\${uploadedFiles === 1 ? '' : 's'} uploaded\`;
          document.getElementById('summary-text').innerHTML =
            'Switch back to your WhatsApp chat and tap <b>✅ I\\'ve uploaded</b> to continue your order.';
        } else {
          document.getElementById('summary-title').textContent =
            \`\${uploadedFiles} uploaded, \${failedFiles} failed\`;
          document.getElementById('summary-text').innerHTML =
            'Some uploads didn\\'t go through. Switch back to WhatsApp and tap <b>✅ I\\'ve uploaded</b> to continue with the ones that worked, or refresh to retry the failed ones.';
        }

        // Deliberately NO wa.me/whatsapp:// deep link: re-opening the chat via a
        // click-to-chat link makes subsequent bot replies surface as push
        // notifications while the user is in the conversation. They return via
        // the app switcher and tap the "✅ I've uploaded" button instead.
        whatsappCta.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;
}


// ===== Route registration =====

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // Register multipart support if not already
  if (!app.hasContentTypeParser('multipart/form-data')) {
    await app.register(multipart, {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB per file
        files: 200, // max 200 files per session
      },
    });
  }

  // GET /u/:token — serve the upload page
  app.get('/u/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = await getSession(token);

    if (!session) {
      reply.status(404).type('text/html').send(`
        <html>
          <head><title>Link expired</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #0a0a0a; color: white;">
            <h1>Link expired</h1>
            <p>This upload link has expired. Please return to WhatsApp and start a new order.</p>
          </body>
        </html>
      `);
      return;
    }

    reply.type('text/html').send(uploadPageHtml(token, session.sizeCode, env.BUSINESS_PHONE ?? ''));
  });

  // POST /api/upload/:token — receive a file
  app.post('/api/upload/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const session = await getSession(token);

    if (!session) {
      reply.status(404).send({ error: 'Session expired or not found' });
      return;
    }

    if (session.imageCount >= MAX_SESSION_FILES || session.uploadedBytes >= MAX_SESSION_BYTES) {
      logger.warn(
        { token, imageCount: session.imageCount, uploadedBytes: session.uploadedBytes },
        'Upload session cap reached',
      );
      reply.status(413).send({ error: 'Upload limit reached for this session.' });
      return;
    }

    try {
      const data = await request.file();
      if (!data) {
        reply.status(400).send({ error: 'No file uploaded' });
        return;
      }

      const buffer = await data.toBuffer();

      // Store in B2 — same function the WhatsApp flow uses
      const stored = await storeImage(
        buffer,
        session.customerId,
        data.mimetype,
        false, // web uploads are not WhatsApp-compressed
        data.filename,
      );

      if (!stored) {
        reply.status(400).send({ error: 'Failed to process image' });
        return;
      }

      // Atomic increments — the upload page can post several files in parallel.
      await db
        .update(uploadSessions)
        .set({
          imageCount: sql`${uploadSessions.imageCount} + 1`,
          uploadedBytes: sql`${uploadSessions.uploadedBytes} + ${stored.fileSizeBytes}`,
        })
        .where(eq(uploadSessions.id, session.id));

      logger.info(
        { token, imageId: stored.imageId, customerId: session.customerId },
        'Web upload received',
      );

      return {
        ok: true,
        imageId: stored.imageId,
        widthPx: stored.widthPx,
        heightPx: stored.heightPx,
      };
    } catch (err) {
      logger.error({ err, token }, 'Upload error');
      return reply.status(500).send({ error: 'Upload failed' });
    }
  });

  // GET /api/upload/:token/status — check session status
  app.get('/api/upload/:token/status', async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = await getSession(token);

    if (!session) {
      reply.status(404).send({ error: 'Session not found' });
      return;
    }

    return {
      imageCount: session.imageCount,
      sizeCode: session.sizeCode,
      expiresAt: session.expiresAt,
    };
  });
}

/**
 * Get all images uploaded in a session.
 * Called by the bot when customer types UPLOADED.
 */
export async function getSessionImages(token: string): Promise<{
  customerId: string;
  sizeCode: string;
  imageIds: string[];
} | null> {
  const session = await getSession(token);
  if (!session) return null;

  // Get all images uploaded by this customer since the session started
  const sessionImages = await db
    .select({ id: images.id })
    .from(images)
    .where(
      and(
        eq(images.customerId, session.customerId),
        gte(images.uploadedAt, session.createdAt),
      ),
    );

  return {
    customerId: session.customerId,
    sizeCode: session.sizeCode,
    imageIds: sessionImages.map((i) => i.id),
  };
}

/** Mark a session as completed */
export async function completeSession(token: string): Promise<void> {
  await db
    .update(uploadSessions)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(uploadSessions.token, token));
}
