/**
 * # route.ts (/api/support/turn) - one customer chat turn, streamed back as server-sent events
 *
 * - The conversation id lives in an httpOnly cookie, so a browser can only continue its own conversation.
 * - Events: text (reply deltas), tool (action cards), paypal (live API trace), error, done.
 */
import Anthropic from "@anthropic-ai/sdk";
import { cookies } from "next/headers";
import { z } from "zod";
import { runTurnOpenAI } from "@/lib/agent/openai-agent";
import { runTurn, type AgentEvent } from "@/lib/agent/support-agent";
import { conversations } from "@/lib/db/schema";
import { realDeps } from "@/lib/deps";
import { onPayPalCall } from "@/lib/paypal/client";
import { allow, clientIp } from "@/lib/rate-limit";

const Body = z.object({ text: z.string().trim().min(1).max(2000) });

export async function POST(req: Request) {
  const ip = clientIp(req);
  // Each turn can cost several Claude calls: limit per IP per 10 minutes and per day.
  if (!allow(`turn:${ip}`, 30, 10 * 60_000) || !allow(`turn-day:${ip}`, 200, 24 * 3_600_000))
    return Response.json({ error: "Too many messages. Please wait a few minutes." }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send {text} with 1-2000 characters." }, { status: 400 });
  // LLM_CHAIN (Gemini / Groq / Ollama) wins when set; otherwise Claude.
  const useChain = !!process.env.LLM_CHAIN;
  if (!useChain && !process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet." }, { status: 503 });

  const deps = await realDeps();
  const jar = await cookies();
  let conversationId = jar.get("conv")?.value;
  if (!conversationId) {
    [{ id: conversationId }] = await deps.db.insert(conversations).values({ channel: "CHAT" }).returning({ id: conversations.id });
    jar.set("conv", conversationId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      // shortcut: trace listeners are process-wide, so simultaneous turns see each other's calls; the client
      // reports path templates without ids, so nothing customer-specific crosses over.
      const off = onPayPalCall((t) => send("paypal", t));
      try {
        const turn = { ctx: { conversationId: conversationId!, caller: "CUSTOMER" as const }, userText: parsed.data.text, deps, emit: (e: AgentEvent) => send(e.type, e) };
        await (useChain ? runTurnOpenAI(turn) : runTurn({ ...turn, client: new Anthropic() }));
      } catch (e) {
        console.error("support turn failed", e);
        send("error", { message: "Something went wrong on our side. Please try again." });
      } finally {
        off();
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}
