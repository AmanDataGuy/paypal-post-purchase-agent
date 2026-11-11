/**
 * # webhooks.ts - PayPal webhook intake: verify the signature with PayPal, drop duplicates, react to disputes
 *
 * - Never trusts the body for decisions: dispute events only trigger a fresh sync from the API.
 */
import { eq } from "drizzle-orm";
import { webhookEvents } from "./db/schema";
import { allow, clientIp } from "./rate-limit";
import { syncCases } from "./cases";
import type { Deps } from "./gateway/tools";

type Event = { id: string; event_type: string; resource?: { id?: string; dispute_id?: string } };

// Ask PayPal whether these headers + body are a genuine webhook for our webhook id.
async function verified(deps: Deps, req: Request, event: Event, webhookId: string) {
  const h = (k: string) => req.headers.get(k) ?? "";
  const r = await deps.paypal<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    body: {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return r.verification_status === "SUCCESS";
}

// Handle one webhook POST and return the HTTP response PayPal should get.
export async function handleWebhook(req: Request, deps: Deps, webhookId = process.env.PAYPAL_WEBHOOK_ID): Promise<Response> {
  if (!webhookId) return Response.json({ error: "Webhooks not configured" }, { status: 503 });
  // Cheap rejects first, so junk traffic never costs a PayPal verification call.
  if (!req.headers.get("paypal-transmission-sig") || !req.headers.get("paypal-cert-url"))
    return Response.json({ error: "Missing PayPal signature headers" }, { status: 400 });
  if (!allow(`webhook:${clientIp(req)}`, 120, 60_000)) return Response.json({ error: "Too many requests" }, { status: 429 });
  const text = await req.text();
  if (text.length > 256_000) return Response.json({ error: "Body too large" }, { status: 413 });
  let event: Event;
  try {
    event = JSON.parse(text);
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!event?.id || !(await verified(deps, req, event, webhookId))) return Response.json({ error: "Unverified" }, { status: 400 });

  const [seen] = await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id));
  if (seen) return Response.json({ ok: true, duplicate: true });
  // Sync before recording the event: if the sync fails we answer 500 and PayPal's retry is processed, not dropped.
  if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) await syncCases(deps);
  await deps.db
    .insert(webhookEvents)
    .values({ id: event.id, type: event.event_type, resourceId: event.resource?.dispute_id ?? event.resource?.id, payload: event })
    .onConflictDoNothing();
  return Response.json({ ok: true, duplicate: false });
}
