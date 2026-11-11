/**
 * # config.ts - reads and checks environment variables once
 *
 * - Refuses any PayPal URL other than the sandbox: this app must never touch live money.
 * - Keys for later features (Anthropic, DB) are optional here; the code that needs them checks.
 */
import { z } from "zod";

export const SANDBOX_URL = "https://api-m.sandbox.paypal.com";

const schema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_BASE_URL: z.literal(SANDBOX_URL).default(SANDBOX_URL),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

// Parse env, throwing a readable error if something required is missing or not sandbox.
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) throw new Error(`Bad environment: ${z.prettifyError(r.error)}`);
  return r.data;
}

let cached: Env | undefined;
export const env = (): Env => (cached ??= loadEnv());
