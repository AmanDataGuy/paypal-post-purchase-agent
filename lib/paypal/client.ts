/**
 * # client.ts - the one place that talks HTTP to PayPal
 *
 * - Caches the OAuth token (refreshes 5 min early; concurrent callers share one refresh).
 * - Retries 429/5xx with backoff, refreshes the token once on 401.
 * - Sends `PayPal-Request-Id` when given, so retried money moves are not repeated by PayPal.
 * - Every call is reported to `onPayPalCall` listeners so the UI can show a live API trace.
 */
import { env } from "../config";

export class PayPalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type TraceEntry = { method: string; path: string; status: number; ms: number; debugId?: string };
const listeners = new Set<(t: TraceEntry) => void>();
// Subscribe to every PayPal call (used for the on-screen API trace). Returns an unsubscribe function.
export function onPayPalCall(fn: (t: TraceEntry) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// "/v2/payments/captures/3C679366HH908993F/refund?x=1" -> "/v2/payments/captures/:id/refund" (no ids leave the server).
export const pathTemplate = (path: string) => path.split("?")[0].replace(/\/(?=[A-Z0-9-]*\d)[A-Z0-9-]{6,}(?=\/|$)/g, "/:id");

let token: { value: string; expiresAt: number } | undefined;
let refreshing: Promise<string> | undefined;

// Get a valid access token, fetching a new one only when needed.
export async function getAccessToken(force = false): Promise<string> {
  if (!force && token && Date.now() < token.expiresAt) return token.value;
  refreshing ??= (async () => {
    const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, PAYPAL_BASE_URL: base } = env();
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const json = await res.json();
    if (!res.ok) throw new PayPalError(res.status, json.error ?? "AUTH_FAILED", json.error_description ?? "token request failed");
    token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
    return token.value;
  })().finally(() => (refreshing = undefined));
  return refreshing;
}

// `form` sends multipart/form-data (PayPal's provide-evidence takes an `input` JSON part plus optional files).
type Options = { body?: unknown; form?: FormData; requestId?: string; headers?: Record<string, string> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Call a PayPal REST endpoint and return parsed JSON, or throw PayPalError.
export async function paypal<T = unknown>(method: string, path: string, opts: Options = {}): Promise<T> {
  let forceToken = false;
  let authRetried = false;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const res = await fetch(`${env().PAYPAL_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await getAccessToken(forceToken)}`,
        ...(!opts.form && { "Content-Type": "application/json" }), // fetch sets the multipart boundary itself
        Prefer: "return=representation",
        ...(opts.requestId && { "PayPal-Request-Id": opts.requestId }),
        ...opts.headers,
      },
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    forceToken = false;
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    listeners.forEach((fn) => fn({ method, path: pathTemplate(path), status: res.status, ms: Date.now() - started, debugId }));

    if (res.status === 401 && !authRetried) {
      authRetried = forceToken = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(300 * 2 ** attempt + Math.random() * 100);
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new PayPalError(res.status, json.name ?? json.error ?? "PAYPAL_ERROR", json.message ?? text, debugId ?? json.debug_id, json.details);
    return json as T;
  }
}
