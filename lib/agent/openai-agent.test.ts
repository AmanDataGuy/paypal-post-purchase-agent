/**
 * # openai-agent.test.ts - the OpenAI-compatible tool loop and model fallback, with scripted replies (no network)
 */
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema";
import { makeWorld } from "../testing";
import { chat, parseChain, runTurnOpenAI, type ChatFn, type ChatReply } from "./openai-agent";
import type { AgentEvent } from "./support-agent";

const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("verifies, reads facts, refunds through the gateway, and keeps history", async () => {
  const w = await makeWorld();
  const rounds: ChatReply[] = [
    { model: "x", finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call("c1", "verify_customer", { order_number: "JP-1042", email: "sam@example.test" }), call("c2", "get_order_status", { order_number: "JP-1042" })] } },
    { model: "x", finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call("c3", "issue_refund", { order_number: "JP-1042", amount: "38.00", reason_code: "NOT_RECEIVED", customer_confirmed: true })] } },
    { model: "x", finish_reason: "stop", message: { role: "assistant", content: "Done: $38.00 is on its way back." } },
  ];
  const fake: ChatFn = async () => rounds.shift()!;
  const events: AgentEvent[] = [];
  await runTurnOpenAI({ ctx: { conversationId: "chat1", caller: "CUSTOMER" }, userText: "yes please refund", deps: w.deps, emit: (e) => events.push(e), chat: fake });

  expect(events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name)).toEqual(["verify_customer", "get_order_status", "issue_refund"]);
  expect(events.find((e) => e.type === "tool" && e.name === "issue_refund")).toMatchObject({ result: { ok: true, decision: { kind: "ALLOW" } } });
  expect(events.at(-1)).toEqual({ type: "done", reason: "answered" });
  const [conv] = await w.db.select().from(conversations).where(eq(conversations.id, "chat1"));
  expect((conv.messages as { role: string }[]).map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "tool", "assistant"]);
});

it("a tool call with broken JSON fails validation instead of crashing", async () => {
  const w = await makeWorld();
  const rounds: ChatReply[] = [
    { model: "x", finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "issue_refund", arguments: "{not json" } }] } },
    { model: "x", finish_reason: "stop", message: { role: "assistant", content: "Sorry, let me try again." } },
  ];
  const events: AgentEvent[] = [];
  await runTurnOpenAI({ ctx: { conversationId: "chat1", caller: "CUSTOMER" }, userText: "refund", deps: w.deps, emit: (e) => events.push(e), chat: async () => rounds.shift()! });
  expect(events.find((e) => e.type === "tool")).toMatchObject({ result: { ok: false } });
});

it("falls through to the next model on a rate limit", async () => {
  vi.stubEnv("GEMINI_API_KEY", "k");
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    urls.push(`${url} ${JSON.parse(init.body as string).model}`);
    if (urls.length === 1) return new Response("{}", { status: 429 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }] });
  });
  const r = await chat([{ role: "user", content: "hi" }], { chain: "gemini:a,ollama:qwen3:8b" });
  expect(r).toMatchObject({ model: "ollama:qwen3:8b", message: { content: "hi" } });
  expect(urls[1]).toBe("http://localhost:11434/v1/chat/completions qwen3:8b");
});

it("rejects an unknown provider", () => {
  expect(() => parseChain("openia:gpt")).toThrow(/unknown provider/);
});
