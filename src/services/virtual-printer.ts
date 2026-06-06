/**
 * Virtual printers — service virtualisation for the print flow.
 *
 * When VIRTUAL_PRINTERS=true, the backend runs an in-process "virtual agent"
 * that calls the SAME agent endpoints a real print agent uses (next → start →
 * done) for each printer type. Jobs move queued → printing → done with a short
 * dwell, so the full order lifecycle (paid → printing → printed) is observable
 * in real time in the admin dashboard — no hardware, no separate agent process.
 *
 * Reusing the real endpoints means the simulated flow is identical to a real
 * agent's (same per-order slip sequencing, same order-status advancement).
 *
 * OFF by default. Do NOT enable alongside a real agent — they would race.
 */
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

const PRINTER_TYPES = ['dye_sub_4x6', 'dye_sub_5x7', 'inkjet', 'thermal_label'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startVirtualPrinters(baseUrl: string): void {
  if (!env.VIRTUAL_PRINTERS) return;
  if (!env.PRINT_AGENT_API_KEY) {
    logger.warn('VIRTUAL_PRINTERS is on but PRINT_AGENT_API_KEY is unset — virtual printers disabled');
    return;
  }

  logger.info('🖨️  Virtual printers ENABLED — simulating the print flow (no hardware)');
  const headers = { 'x-print-agent-key': env.PRINT_AGENT_API_KEY };
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      for (const pt of PRINTER_TYPES) {
        const res = await fetch(`${baseUrl}/api/agent/jobs/next?printer_type=${pt}`, { headers });
        if (res.status !== 200) continue;
        const job = (await res.json()) as {
          id: string;
          jobKind?: string;
          slipType?: string;
          orderNumber?: string;
          sizeCode?: string;
        };
        await fetch(`${baseUrl}/api/agent/jobs/${job.id}/start`, { method: 'POST', headers });
        logger.info(
          { jobId: job.id, kind: job.jobKind ?? 'print', slipType: job.slipType, sizeCode: job.sizeCode, pt },
          '🖨️  [virtual] printing…',
        );
        await sleep(env.VIRTUAL_PRINT_MS);
        await fetch(`${baseUrl}/api/agent/jobs/${job.id}/done`, { method: 'POST', headers });
        logger.info({ jobId: job.id }, '🖨️  [virtual] done');
        break; // one job per tick — keeps the flow visible and orderly
      }
    } catch (err) {
      logger.error({ err }, 'virtual printer tick failed');
    } finally {
      busy = false;
    }
  };

  setInterval(() => void tick(), env.VIRTUAL_POLL_MS).unref();
}
