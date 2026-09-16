import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const numeric = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: numeric(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    AI_PROVIDER: z.enum(['mock', 'openai', 'failing']).default('mock'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),

    RETRIEVAL_MODE: z.enum(['lexical', 'full']).default('lexical'),

    WEB_ORIGIN: z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    AI_TIMEOUT_MS: numeric(15_000),
    AI_MAX_RETRIES: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v === '' ? 2 : Number(v)))
      .pipe(z.number().int().min(0).max(5)),
    RATE_LIMIT_WINDOW_MS: numeric(60_000),
    RATE_LIMIT_MAX: numeric(30),
  })
  // Fail at boot, not on the first guest message: an openai deployment with no
  // key is a misconfiguration we want to find in CI, not in production traffic.
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai. Set it in apps/server/.env, or use AI_PROVIDER=mock.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid server configuration:\n${lines.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Tests flip provider/retrieval modes between cases. */
export function resetEnvCache(): void {
  cached = null;
}
