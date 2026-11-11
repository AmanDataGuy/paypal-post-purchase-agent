/**
 * # route.ts (/api/webhooks/paypal) - receives PayPal webhooks (register this URL in the developer dashboard)
 */
import { handleWebhook } from "@/lib/webhooks";
import { realDeps } from "@/lib/deps";

export async function POST(req: Request) {
  return handleWebhook(req, await realDeps());
}
