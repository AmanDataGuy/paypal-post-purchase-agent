/**
 * # support-agent.ts - runs one customer turn: Claude proposes tool calls, the gateway decides and acts
 *
 * - Manual streaming tool loop (we own the loop so every call goes through the gateway and gets audited).
 * - History is append-only and stored whole (thinking and fallback blocks included), as the API requires.
 * - Emits events for the UI: text deltas, tool results (action cards), done.
 */
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema";
import { execute } from "../gateway/gateway";
import { anthropicTools, type Ctx, type Deps, type ToolResult } from "../gateway/tools";
import { SUPPORT_PROMPT } from "./prompt";

// AGENT_MODEL in .env picks a cheaper model for testing; record the demo on Opus.
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const MODEL = MODELS.find((m) => m === process.env.AGENT_MODEL) ?? "claude-opus-5-5";
const MAX_ROUNDS = 8; // model calls per customer turn
const MAX_CUSTOMER_TURNS = 30; // per conversation

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; input: unknown; result: ToolResult }
  | { type: "done"; reason: "answered" | "refusal" | "round_limit" };

// Only the slice of the SDK client we use, so tests can pass a fake.
export type LlmClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "stream"> } };

// Run Claude until it answers the customer, executing its tool calls through the gateway.
export async function runTurn(opts: {
  ctx: Ctx;
  userText: string;
  deps: Deps;
  client: LlmClient;
  emit: (e: AgentEvent) => void;
}): Promise<void> {
  const { ctx, deps, client, emit } = opts;
  const [conv] = await deps.db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
  if (!conv) throw new Error(`Unknown conversation ${ctx.conversationId}`);
  const history = conv.messages as Anthropic.Beta.BetaMessageParam[];
  // Cap spend per conversation: customer turns are the user messages whose content is plain text.
  if (history.filter((m) => m.role === "user" && typeof m.content === "string").length >= MAX_CUSTOMER_TURNS) {
    emit({ type: "text", delta: "This chat has reached its length limit. Please start a new one, or ask the shop by email." });
    return emit({ type: "done", reason: "round_limit" });
  }
  const messages = [...history, { role: "user", content: opts.userText } as const];
  const save = () => deps.db.update(conversations).set({ messages }).where(eq(conversations.id, conv.id));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 8000, // replies are 2-4 sentences; this bounds thinking + text per call
      system: [{ type: "text", text: SUPPORT_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: anthropicTools as Anthropic.Beta.BetaTool[],
      messages,
      cache_control: { type: "ephemeral" }, // caches the growing history, so each round re-reads it at ~1/20 price
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // Haiku has no server-side refusal fallback; a refusal there hands off (below).
      ...(MODEL === "claude-haiku-5-5" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const msg = await stream.finalMessage();
    messages.push({ role: "assistant", content: msg.content });

    // A refusal can cut a tool call off mid-input; never run that turn's tools.
    if (msg.stop_reason === "refusal") {
      emit({ type: "text", delta: "I can't help with that here. Let me pass you to the shop owner." });
      await save();
      return emit({ type: "done", reason: "refusal" });
    }
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0 || msg.stop_reason === "max_tokens") {
      await save();
      return emit({ type: "done", reason: "answered" });
    }

    // Run this round's tool calls in order (verify must land before a read in the same round), then return every
    // result in one user message.
    const results: ToolResult[] = [];
    for (const u of uses) results.push(await execute(u.name, u.input, ctx, deps));
    uses.forEach((u, i) => emit({ type: "tool", name: u.name, input: u.input, result: results[i] }));
    messages.push({
      role: "user",
      content: uses.map((u, i) => ({ type: "tool_result" as const, tool_use_id: u.id, content: JSON.stringify(results[i]) })),
    });
    await save();
  }
  emit({ type: "text", delta: "This is taking longer than it should. I've passed it to the shop owner." });
  await save();
  emit({ type: "done", reason: "round_limit" });
}
