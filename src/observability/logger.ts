import pino from 'pino';
import { env } from '../config/env.js';
import fs from 'node:fs';
import path from 'node:path';

const logDir = path.dirname(env.LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      level: env.LOG_LEVEL,
    },
    {
      target: 'pino/file',
      options: { destination: env.LOG_FILE, mkdir: true },
      level: env.LOG_LEVEL,
    },
  ],
});

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: { service: 'code-review-agent', environment: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        '*.apiKey',
        '*.token',
        '*.secret',
        '*.password',
        '*.authorization',
        '*.OPENAI_API_KEY',
      ],
      censor: '[REDACTED]',
    },
  },
  transport,
);

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
