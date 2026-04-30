import pino from 'pino';
import { env } from '@/config/env.js';

const isDev = env.NODE_ENV === 'development';
const isSilent = env.LOG_LEVEL === 'silent';

export const logger = pino({
  level: isSilent ? 'silent' : env.LOG_LEVEL,
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