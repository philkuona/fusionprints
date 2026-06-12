import pino from 'pino';
import { env } from '@/config/env.js';

const isDev = env.NODE_ENV === 'development';
const isSilent = env.LOG_LEVEL === 'silent';

// PII guard (audit IMP-9): phone numbers appear all over bot/notification
// logs. Mask to country code + last two digits — still correlatable for
// support, no longer a raw PII dump if logs ever leave journald.
function maskPhone(value: unknown): string {
  const s = String(value ?? '');
  return s.length > 6 ? `${s.slice(0, 4)}***${s.slice(-2)}` : '***';
}

export const logger = pino({
  level: isSilent ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'phoneNumber', '*.phoneNumber',
      'phone', '*.phone',
      'ecocashNumber', '*.ecocashNumber',
      'whatsapp', '*.whatsapp',
    ],
    censor: maskPhone,
  },
  ...(isDev && !isSilent && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
});