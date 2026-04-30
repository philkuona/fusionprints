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
import { eq, and, gte } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db } from '@/db/client.js';
import { uploadSessions, customers } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { storeImage } from '@/services/image-storage.js';

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

function uploadPageHtml(token: string, sizeCode: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upload your photos — FusionPrints</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&family=DM+Sans:wght@400;500;600&display=swap');

    :root {
      --bg: #0a0a0a;
      --surface: #141414;
      --surface2: #1e1e1e;
      --border: #2a2a2a;
      --text: #f0f0f0;
      --text2: #888;
      --accent: #f97316;
      --green: #22c55e;
      --red: #ef4444;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 16px;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
    }

    header {
      padding: 16px 0 24px;
      text-align: center;
    }

    .logo {
      font-family: 'DM Mono', monospace;
      font-size: 18px;
      color: var(--accent);
      letter-spacing: -0.5px;
    }
    .logo span { color: var(--text2); }

    h1 {
      font-size: 22px;
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 8px;
    }

    .subtitle {
      color: var(--text2);
      font-size: 14px;
      margin-bottom: 24px;
    }

    .size-badge {
      display: inline-block;
      background: var(--surface2);
      border: 1px solid var(--accent);
      color: var(--accent);
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 8px;
      font-family: 'DM Mono', monospace;
    }

    .drop-zone {
      border: 2px dashed var(--border);
      border-radius: 12px;
      padding: 48px 24px;
      text-align: center;
      cursor: pointer;
      transition: all 0.15s;
      background: var(--surface);
    }

    .drop-zone:hover, .drop-zone.dragging {
      border-color: var(--accent);
      background: var(--surface2);
    }

    .drop-zone-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }

    .drop-zone-text {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 6px;
    }

    .drop-zone-hint {
      color: var(--text2);
      font-size: 13px;
    }

    #file-input {
      display: none;
    }

    .files-list {
      margin-top: 24px;
    }

    .files-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      font-size: 13px;
      color: var(--text2);
    }

    .file-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .file-icon {
      font-size: 22px;
    }

    .file-info {
      flex: 1;
      min-width: 0;
    }

    .file-name {
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-size {
      font-size: 12px;
      color: var(--text2);
      font-family: 'DM Mono', monospace;
    }

    .file-status {
      font-size: 12px;
      font-weight: 500;
      flex-shrink: 0;
    }

    .file-status.uploading { color: var(--accent); }
    .file-status.done { color: var(--green); }
    .file-status.error { color: var(--red); }

    .progress-bar {
      width: 60px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
      margin-left: 8px;
      flex-shrink: 0;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.2s;
    }

    .summary {
      margin-top: 24px;
      padding: 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      text-align: center;
    }

    .summary.success {
      border-color: var(--green);
    }

    .summary-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .summary-text {
      color: var(--text2);
      font-size: 14px;
      line-height: 1.5;
    }

    .whatsapp-cta {
      display: inline-block;
      margin-top: 16px;
      background: #25d366;
      color: white;
      padding: 10px 20px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">Fusion<span>Prints</span></div>
      <h1>Upload your photos</h1>
      <div class="size-badge" id="size-badge">${sizeCode}</div>
      <div class="subtitle">Drop them here, then return to WhatsApp and reply <strong>UPLOADED</strong></div>
    </header>

    <div class="drop-zone" id="drop-zone">
      <div class="drop-zone-icon">📸</div>
      <div class="drop-zone-text">Drop photos here or tap to choose</div>
      <div class="drop-zone-hint">JPEG, PNG, HEIC — any quantity, original quality</div>
      <input type="file" id="file-input" accept="image/*" multiple>
    </div>

    <div class="files-list" id="files-list"></div>

    <div class="summary" id="summary" style="display:none">
      <div class="summary-title" id="summary-title">All done! 🎉</div>
      <div class="summary-text" id="summary-text">Return to WhatsApp and reply <strong>UPLOADED</strong> to continue your order.</div>
    </div>
  </div>

  <script>
    const TOKEN = '${token}';
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const filesList = document.getElementById('files-list');
    const summary = document.getElementById('summary');

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
    }

    async function uploadFile(file) {
      // Create UI item
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = \`
        <span class="file-icon">📷</span>
        <div class="file-info">
          <div class="file-name">\${file.name}</div>
          <div class="file-size">\${formatSize(file.size)}</div>
        </div>
        <div class="progress-bar"><div class="progress-fill"></div></div>
        <div class="file-status uploading">uploading…</div>
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

      checkComplete();
    }

    function checkComplete() {
      if (uploadedFiles + failedFiles === totalFiles && totalFiles > 0) {
        summary.style.display = 'block';
        summary.className = 'summary success';
        if (failedFiles === 0) {
          document.getElementById('summary-title').textContent =
            \`\${uploadedFiles} photo\${uploadedFiles === 1 ? '' : 's'} uploaded! 🎉\`;
        } else {
          document.getElementById('summary-title').textContent =
            \`\${uploadedFiles} uploaded, \${failedFiles} failed\`;
        }
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

    reply.type('text/html').send(uploadPageHtml(token, session.sizeCode));
  });

  // POST /api/upload/:token — receive a file
  app.post('/api/upload/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const session = await getSession(token);

    if (!session) {
      reply.status(404).send({ error: 'Session expired or not found' });
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

      // Increment image count on the session
      await db
        .update(uploadSessions)
        .set({ imageCount: session.imageCount + 1 })
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
      reply.status(500).send({ error: 'Upload failed' });
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

  const { images } = await import('@/db/schema.js');
  const { gte: gteDate } = await import('drizzle-orm');

  // Get all images uploaded by this customer since the session started
  const sessionImages = await db
    .select({ id: images.id })
    .from(images)
    .where(
      and(
        eq(images.customerId, session.customerId),
        gteDate(images.uploadedAt, session.createdAt),
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
