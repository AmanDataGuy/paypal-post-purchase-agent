/**
 * # openai-agent.ts - the support agent on any OpenAI-compatible model (Gemini, Groq, local Ollama)
 *
 * - Same job as support-agent.ts (Claude): the model proposes tool calls, the gateway decides and acts.
 * - `LLM_CHAIN` in .env picks the models, tried in order: on a rate limit, server error or timeout the next one
 *   answers. Example: `LLM_CHAIN=gemini:gemini-3.6-flash,gemini:gemini-3.5-flash-lite,ollama:qwen3:8b`.
 * - No SDK: one fetch to `/chat/completions`. Replies arrive whole, not streamed.
 */
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema";
import { execute } from "../gateway/gateway";
import { anthropicTools, type Ctx, type Deps, type ToolResult } from "../gateway/tools";
import { SUPPORT_PROMPT } from "./prompt";
import type { AgentEvent } from "./support-agent";

const MAX_ROUNDS = 8; // model calls per customer turn
const MAX_CUSTOMER_TURNS = 30; // per conversation
const TIMEOUT_MS = 45_000; // a free-tier model sometimes hangs; move on to the next one

const PROVIDERS: Record<string, { url: string; key: () => string | undefined }> = {
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai", key: () => process.env.GEMINI_API_KEY },
  groq: { url: "https://api.groq.com/openai/v1", key: () => process.env.GROQ_API_KEY },
  ollama: { url: process.env.OLLAMA_URL ?? "http://localhost:11434/v1", key: () => "ollama" },
};

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatReply = { message: Msg; finish_reason: string; model: string };
export type ChatFn = (messages: Msg[], opts?: { tools?: boolean; chain?: string }) => Promise<ChatReply>;

// The gateway's tools in the OpenAI "function" format, from the same zod schemas Claude uses.
const tools = anthropicTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// Split "provider:model" (the model name may itself contain a colon, as in qwen3:8b).
export function parseChain(chain: string) {
  return chain.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(":");
    const provider = s.slice(0, i);
    if (!PROVIDERS[provider]) throw new Error(`LLM_CHAIN: unknown provider "${provider}" (use ${Object.keys(PROVIDERS).join(", ")})`);
    return { provider, model: s.slice(i + 1) };
  });
}

// Ask the first model in the chain that answers. Rate limits and outages fall through to the next one; when every
// model is rate limited, wait and go round again (free tiers reset per minute).
export const chat: ChatFn = async (messages, opts = {}) => {
  const chain = parseChain(opts.chain ?? process.env.LLM_CHAIN ?? "");
  if (!chain.length) throw new Error("LLM_CHAIN is empty");
  const errors: string[] = [];
  for (let lap = 0; lap < 4; lap++) {
    for (const { provider, model } of chain) {
      const p = PROVIDERS[provider];
      const key = p.key();
      if (!key) {
        errors.push(`${provider}: no API key`);
        continue;
      }
      try {
        const res = await fetch(`${p.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages,
            ...(opts.tools ? { tools } : {}),
            ...(provider === "gemini" ? { reasoning_effort: "low" } : {}), // keeps latency down; the gate does the hard checks
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 429 || res.status >= 500) {
          errors.push(`${provider}:${model} HTTP ${res.status}`);
          continue;
        }
        const body = await res.json();
        if (!res.ok) throw new Error(`${provider}:${model} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
        const choice = body.choices?.[0];
        if (!choice?.message) throw new Error(`${provider}:${model} returned no message`);
        return { message: choice.message, finish_reason: choice.finish_reason ?? "stop", model: `${provider}:${model}` };
      } catch (e) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "TypeError")) {
          errors.push(`${provider}:${model} ${e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
          continue;
        }
        throw e; // a 4xx other than 429 is our bug (bad request, bad key): fail loudly
      }
    }
    if (lap < 3) await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error(`No model answered: ${errors.slice(-chain.length).join("; ")}`);
};

// Run the model until it answers the customer, executing its tool calls through the gateway.
export async function runTurnOpenAI(opts: { ctx: Ctx; userText: string; deps: Deps; emit: (e: AgentEvent) => void; chat?: ChatFn }): Promise<void> {
  const { ctx, deps, emit } = opts;
  const ask = opts.chat ?? chat;
  const [conv] = await deps.db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
  if (!conv) throw new Error(`Unknown conversation ${ctx.conversationId}`);
  // shortcut: history is stored in this provider's format; a conversation started on Claude can't continue here.
  const history = conv.messages as Msg[];
  if (history.filter((m) => m.role === "user").length >= MAX_CUSTOMER_TURNS) {
    emit({ type: "text", delta: "This chat has reached its length limit. Please start a new one, or ask the shop by email." });
    return emit({ type: "done", reason: "round_limit" });
  }
  const messages: Msg[] = [...history, { role: "user", content: opts.userText }];
  const save = () => deps.db.update(conversations).set({ messages }).where(eq(conversations.id, conv.id));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { message, finish_reason } = await ask([{ role: "system", content: SUPPORT_PROMPT }, ...messages], { tools: true });
    messages.push(message); // kept whole: Gemini needs its thought signatures back on the next call
    if (message.content) emit({ type: "text", delta: message.content });

    if (finish_reason === "content_filter") {
      emit({ type: "text", delta: "I can't help with that here. Let me pass you to the shop owner." });
      await save();
      return emit({ type: "done", reason: "refusal" });
    }
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      await save();
      return emit({ type: "done", reason: "answered" });
    }

    // In order: verify must land before a read in the same round. Bad JSON from the model fails schema validation.
    for (const c of calls) {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = { unparseable_arguments: c.function.arguments };
      }
      const result: ToolResult = await execute(c.function.name, input, ctx, deps);
      emit({ type: "tool", name: c.function.name, input, result });
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
    }
    await save();
  }
  emit({ type: "text", delta: "This is taking longer than it should. I've passed it to the shop owner." });
  await save();
  emit({ type: "done", reason: "round_limit" });
}
