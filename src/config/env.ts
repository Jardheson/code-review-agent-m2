import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().min(1024).max(65535).default(3000),

  OPENAI_API_KEY: z.string().min(1).default('sk-test-key'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FILE: z.string().default('./logs/app.log'),

  MEMORY_STORAGE_PATH: z.string().default('./data/memory.json'),
  AUDIT_LOG_PATH: z.string().default('./data/audit.log'),

  MAX_TOOL_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  MAX_GRAPH_STEPS: z.coerce.number().int().min(1).max(100).default(15),
  HUMAN_APPROVAL_REQUIRED: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('true'),

  ALLOWED_FILE_EXTENSIONS: z.string().default('.ts,.js,.tsx,.jsx,.py,.java,.go'),
  MAX_DIFF_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  WEBHOOK_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const allowedExtensions = new Set(
  env.ALLOWED_FILE_EXTENSIONS.split(',').map((ext) => ext.trim().toLowerCase()),
);
