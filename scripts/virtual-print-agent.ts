/**
 * FusionPrints — Virtual Print Agent (printer service virtualization)
 *
 * Stands in for the Windows print-server agent so the FULL order workflow
 * can be tested end-to-end with no physical printers:
 *
 *   web checkout → virtual payment → paid → print/slip jobs queued
 *     → THIS AGENT polls /api/agent/jobs/next, claims jobs,
 *       "prints" them into virtual-prints/<order>/ on disk,
 *       reports done → order advances to 'printed'
 *     → operator releases via admin dashboard → ready_for_pickup
 *
 * It exercises the exact same HTTP surface the real agent will use
 * (auth header, polling, start/done/fail, heartbeats), so swapping in the
 * real agent later changes nothing server-side. Mirrors the payment
 * virtualization pattern in services/web-payment.ts.
 *
 * What "printing" means here:
 *   - customer prints + dye-sub slips → file downloaded to the output tray
 *   - thermal envelope labels        → .zpl file written to the output tray
 *   - every job gets a .json manifest next to its output
 *
 * Usage:
 *   npm run agent:virtual                  # poll forever (like the real agent)
 *   npm run agent:virtual -- --once        # drain the queue, then exit
 *   npm run agent:virtual -- --fail-rate=0.2   # simulate paper jams
 *
 * Flags:
 *   --once             drain all queued jobs once, then exit
 *   --interval=<ms>    idle poll interval (default 3000)
 *   --print-time=<ms>  simulated per-copy print time (default: per printer type)
 *   --fail-rate=<0..1> probability a claimed job fails (default 0)
 *   --out=<dir>        output tray directory (default virtual-prints/)
 *   --base-url=<url>   backend URL (default http://localhost:$PORT)
 *
 * Requires PRINT_AGENT_API_KEY in .env and the backend running (npm run dev).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { db, closeDatabase } from '../src/db/client.js';
import { printers } from '../src/db/schema.js';
import { getImageBuffer } from '../src/services/image-storage.js';

// ===== Job shapes returned by /api/agent/jobs/next =====

interface SlipJobResponse {
  id: string;
  jobKind: 'slip';
  slipType: 'order_info' | 'end_separator' | 'envelope_label';
  targetPrinterType: string;
  printReadyFileUrl?: string | null;
  payloadJson?: { zpl?: string } | null;
  sequencePosition: number;
}

interface PrintJobResponse {
  id: string;
  orderItemId: string;
  printerOsName: string;
  printerType: string;
  sizeCode: string;
  productType: string;
  quantity: number;
  imageStorageKey: string;
  imageUrl: string;
  orderNumber: string;
  customerName: string | null;
}

type AgentJob = SlipJobResponse | PrintJobResponse;

const PRINTER_TYPES = ['dye_sub_4x6', 'dye_sub_5x7', 'inkjet', 'thermal_label'] as const;

// Simulated per-copy print times (ms) — roughly proportional to reality,
// fast enough that a full test order completes in seconds.
const PRINT_TIME_MS: Record<string, number> = {
  dye_sub_4x6: 1500,
  dye_sub_5x7: 1500,
  inkjet: 4000,
  thermal_label: 400,
  legacy: 1500, // jobs with no target_printer_type (pre-Phase-D WhatsApp orders)
};

// ===== CLI flags =====

interface Config {
  once: boolean;
  intervalMs: number;
  printTimeMs: number | null;
  failRate: number;
  outDir: string;
  baseUrl: string;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    once: false,
    intervalMs: 3000,
    printTimeMs: null,
    failRate: 0,
    outDir: path.resolve('virtual-prints'),
    baseUrl: `http://localhost:${env.PORT}`,
  };

  for (const arg of argv) {
    const [flag, value] = arg.split('=');
    switch (flag) {
      case '--once':
        config.once = true;
        break;
      case '--interval':
        config.intervalMs = Math.max(250, Number(value) || 3000);
        break;
      case '--print-time':
        config.printTimeMs = Math.max(0, Number(value) || 0);
        break;
      case '--fail-rate':
        config.failRate = Math.min(1, Math.max(0, Number(value) || 0));
        break;
      case '--out':
        config.outDir = path.resolve(value ?? 'virtual-prints');
        break;
      case '--base-url':
        config.baseUrl = value ?? config.baseUrl;
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        process.exit(1);
    }
  }
  return config;
}

// ===== Helpers =====

function ts(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function log(line: string): void {
  console.log(`[${ts()}] ${line}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull an order number (FP-YYYY-NNNN) out of a URL or ZPL payload. */
function extractOrderNumber(text: string): string | null {
  const match = /FP-\d{4}-\d{4,}/.exec(text);
  return match ? match[0] : null;
}

/** Derive a B2 storage key from a raw bucket URL (slip files store these). */
function storageKeyFromUrl(url: string): string | null {
  if (!env.B2_BUCKET_NAME || !env.B2_ENDPOINT) return null;
  const prefix = `https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

function fileExtension(source: string): string {
  const match = /\.(png|jpe?g|tiff?|webp|pdf)(\?|$)/i.exec(source);
  return match ? `.${match[1].toLowerCase()}` : '.jpg';
}

/**
 * Fetch the print-ready file. Signed URLs download directly; raw B2 URLs on a
 * private bucket fall back to an authenticated GetObject via the storage key.
 */
async function fetchPrintFile(url: string, storageKey: string | null): Promise<Buffer> {
  if (url) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      // fall through to storage-key fetch
    }
  }
  if (storageKey) return getImageBuffer(storageKey);
  throw new Error('No downloadable file URL or storage key on job');
}

// ===== The virtual agent =====

class VirtualPrintAgent {
  private running = true;
  private jobsDone = 0;
  private jobsFailed = 0;
  private orderSequence = new Map<string, number>(); // stack position per order

  constructor(private config: Config) {}

  private headers(): Record<string, string> {
    return {
      'X-Print-Agent-Key': env.PRINT_AGENT_API_KEY,
      'Content-Type': 'application/json',
    };
  }

  private async api(pathname: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.baseUrl}${pathname}`, { ...init, headers: this.headers() });
  }

  /** GET /jobs/next for one printer type. Returns null when the queue is empty. */
  private async nextJob(printerType: string | null): Promise<AgentJob | null> {
    const query = printerType ? `?printer_type=${printerType}` : '';
    const res = await this.api(`/api/agent/jobs/next${query}`);
    if (res.status === 404) return null;
    if (res.status === 401) throw new Error('Agent auth rejected — check PRINT_AGENT_API_KEY matches the backend .env');
    if (!res.ok) throw new Error(`jobs/next failed: HTTP ${res.status}`);
    return (await res.json()) as AgentJob;
  }

  private async reportStart(jobId: string): Promise<void> {
    await this.api(`/api/agent/jobs/${jobId}/start`, { method: 'POST', body: '{}' });
  }

  private async reportDone(jobId: string): Promise<void> {
    await this.api(`/api/agent/jobs/${jobId}/done`, { method: 'POST', body: '{}' });
  }

  private async reportFail(jobId: string, reason: string): Promise<void> {
    await this.api(`/api/agent/jobs/${jobId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  /** Next stack position within an order's output folder (001-, 002-, ...). */
  private nextSequence(orderKey: string): string {
    const next = (this.orderSequence.get(orderKey) ?? 0) + 1;
    this.orderSequence.set(orderKey, next);
    return String(next).padStart(3, '0');
  }

  private async writeOutput(orderKey: string, baseName: string, ext: string, content: Buffer | string, manifest: Record<string, unknown>): Promise<string> {
    const dir = path.join(this.config.outDir, orderKey);
    await mkdir(dir, { recursive: true });
    const seq = this.nextSequence(orderKey);
    const filePath = path.join(dir, `${seq}-${baseName}${ext}`);
    await writeFile(filePath, content);
    await writeFile(
      path.join(dir, `${seq}-${baseName}.json`),
      JSON.stringify({ ...manifest, printedAt: new Date().toISOString() }, null, 2),
    );
    return filePath;
  }

  /** Simulate the physical print: wait, maybe jam, write output, report. */
  private async runJob(job: AgentJob, printerType: string | null): Promise<void> {
    const typeKey = printerType ?? 'legacy';
    const isSlip = 'jobKind' in job && job.jobKind === 'slip';

    const label = isSlip
      ? `slip:${(job as SlipJobResponse).slipType}`
      : `print:${(job as PrintJobResponse).sizeCode} x${(job as PrintJobResponse).quantity}`;

    await this.reportStart(job.id);
    log(`▶ ${typeKey.padEnd(13)} ${label}`);

    const quantity = isSlip ? 1 : (job as PrintJobResponse).quantity;
    const perCopy = this.config.printTimeMs ?? PRINT_TIME_MS[typeKey] ?? 1500;
    await sleep(Math.min(perCopy * quantity, 15_000));

    if (this.config.failRate > 0 && Math.random() < this.config.failRate) {
      const reason = 'Virtual printer: simulated media jam';
      await this.reportFail(job.id, reason);
      this.jobsFailed += 1;
      log(`✖ ${typeKey.padEnd(13)} ${label} — FAILED (${reason})`);
      return;
    }

    const outputPath = await this.materialize(job, isSlip, typeKey);
    await this.reportDone(job.id);
    this.jobsDone += 1;
    log(`✔ ${typeKey.padEnd(13)} ${label} → ${path.relative(process.cwd(), outputPath)}`);
  }

  /** Produce the on-disk artifact that stands in for physical output. */
  private async materialize(job: AgentJob, isSlip: boolean, typeKey: string): Promise<string> {
    if (isSlip) {
      const slip = job as SlipJobResponse;

      // Thermal label — the "print" is the ZPL command stream itself.
      if (slip.slipType === 'envelope_label') {
        const zpl = slip.payloadJson?.zpl ?? '';
        const orderKey = extractOrderNumber(zpl) ?? 'unknown-order';
        return this.writeOutput(orderKey, 'envelope-label', '.zpl', zpl, {
          jobId: slip.id,
          kind: 'slip',
          slipType: slip.slipType,
          printerType: typeKey,
        });
      }

      // Dye-sub slip — download the rendered card.
      const url = slip.printReadyFileUrl ?? '';
      const buffer = await fetchPrintFile(url, storageKeyFromUrl(url));
      const orderKey = extractOrderNumber(url) ?? 'unknown-order';
      return this.writeOutput(orderKey, `slip-${slip.slipType}`, fileExtension(url), buffer, {
        jobId: slip.id,
        kind: 'slip',
        slipType: slip.slipType,
        printerType: typeKey,
        sequencePosition: slip.sequencePosition,
        sourceUrl: url,
      });
    }

    // Customer print — download the print-ready render.
    const print = job as PrintJobResponse;
    const buffer = await fetchPrintFile(print.imageUrl, print.imageStorageKey || null);
    const orderKey = print.orderNumber || 'unknown-order';
    const ext = fileExtension(print.imageStorageKey || print.imageUrl);
    return this.writeOutput(orderKey, `print-${print.sizeCode}-x${print.quantity}`, ext, buffer, {
      jobId: print.id,
      kind: 'print',
      sizeCode: print.sizeCode,
      productType: print.productType,
      quantity: print.quantity,
      printerOsName: print.printerOsName,
      printerType: typeKey,
      customerName: print.customerName,
      storageKey: print.imageStorageKey,
    });
  }

  /**
   * One full pass over every printer queue, draining each.
   * The trailing null poll catches legacy jobs with no target_printer_type.
   */
  private async drainPass(): Promise<number> {
    let handled = 0;
    for (const printerType of [...PRINTER_TYPES, null]) {
      while (this.running) {
        const job = await this.nextJob(printerType);
        if (!job) break;
        await this.runJob(job, printerType);
        handled += 1;
      }
      if (!this.running) break;
    }
    return handled;
  }

  /** Mark the DB-registered printers online/offline via the heartbeat API. */
  private async heartbeatAll(status: 'online' | 'offline'): Promise<void> {
    const allPrinters = await db.select().from(printers);
    for (const printer of allPrinters) {
      await this.api(`/api/agent/printers/${printer.id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ status, currentMedia: printer.currentMedia ?? undefined }),
      }).catch(() => undefined);
    }
    if (allPrinters.length > 0) {
      log(`♥ heartbeat: ${allPrinters.map((p) => p.name).join(', ')} → ${status}`);
    }
  }

  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    log(`Virtual print agent online — polling ${this.config.baseUrl}`);
    log(`Output tray: ${this.config.outDir}`);
    if (this.config.failRate > 0) log(`Fail rate: ${this.config.failRate * 100}% (simulated jams)`);

    await this.heartbeatAll('online');
    const heartbeatTimer = setInterval(() => {
      void this.heartbeatAll('online');
    }, 60_000);

    try {
      let idleLogged = false;
      while (this.running) {
        const handled = await this.drainPass();
        if (this.config.once) {
          if (handled === 0) break;
          continue; // keep draining until a pass finds nothing
        }
        if (handled === 0 && !idleLogged) {
          log(`… queue empty, polling every ${this.config.intervalMs}ms (Ctrl+C to stop)`);
          idleLogged = true;
        }
        if (handled > 0) idleLogged = false;
        if (handled === 0) await sleep(this.config.intervalMs);
      }
    } finally {
      clearInterval(heartbeatTimer);
      await this.heartbeatAll('offline');
      log(`Done. ${this.jobsDone} job(s) printed, ${this.jobsFailed} failed.`);
    }
  }
}

// ===== Entry point =====

async function main(): Promise<void> {
  if (!env.PRINT_AGENT_API_KEY) {
    console.error('PRINT_AGENT_API_KEY is not set in .env — the agent API rejects all requests without it.');
    process.exit(1);
  }

  const config = parseArgs(process.argv.slice(2));
  const agent = new VirtualPrintAgent(config);

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('Stopping after current job…');
    agent.stop();
  });

  await agent.run();
}

main()
  .catch((err: unknown) => {
    console.error('Virtual print agent crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
