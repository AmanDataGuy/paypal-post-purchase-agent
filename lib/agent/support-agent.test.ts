/**
 * # support-agent.test.ts - the tool loop with a scripted fake Claude (no network, no cost)
 *
 * - Each fake round returns a prepared assistant message; we check the gateway really ran and history is kept.
 */
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema";
import { makeWorld } from "../testing";
import { runTurn, type AgentEvent, type LlmClient } from "./support-agent";

type Block = Record<string, unknown>;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });

// A fake client whose stream() replays scripted assistant messages in order.
function fakeClient(rounds: { content: Block[]; stop_reason: string }[]) {
  const requests: unknown[] = [];
  const client = {
    beta: {
      messages: {
        stream(req: unknown) {
          requests.push(structuredClone(req));
          const msg = rounds.shift()!;
          const textHandlers: ((d: string) => void)[] = [];
          return {
            on(_event: "text", fn: (d: string) => void) {
              textHandlers.push(fn);
              return this;
            },
            async finalMessage() {
              for (const b of msg.content) if (b.type === "text") textHandlers.forEach((fn) => fn(b.text as string));
              return msg;
            },
          };
        },
      },
    },
  } as unknown as LlmClient;
  return { client, requests };
}

it("verifies, reads facts, refunds through the gateway, and keeps full history", async () => {
  const w = await makeWorld();
  const { client, requests } = fakeClient([
    {
      stop_reason: "tool_use",
      content: [
        toolUse("t1", "verify_customer", { order_number: "JP-1042", email: "sam@example.test" }),
        toolUse("t2", "get_order_status", { order_number: "JP-1042" }),
      ],
    },
    { stop_reason: "tool_use", content: [toolUse("t3", "issue_refund", { order_number: "JP-1042", amount: "38.00", reason_code: "NOT_RECEIVED", customer_confirmed: true })] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Done: $38.00 is on its way back." }] },
  ]);
  const events: AgentEvent[] = [];
  await runTurn({ ctx: { conversationId: "chat1", caller: "CUSTOMER" }, userText: "yes please refund", deps: w.deps, client, emit: (e) => events.push(e) });

  // verify and read arrive in the same round; they must run in order for the read to succeed.
  expect(events.find((e) => e.type === "tool" && e.name === "get_order_status")).toMatchObject({ result: { ok: true } });
  expect(events.filter((e) => e.type === "tool").map((e) => (e as { name: string }).name)).toEqual(["verify_customer", "get_order_status", "issue_refund"]);
  expect(w.refundPosts()).toBe(1);
  expect(events.at(-1)).toEqual({ type: "done", reason: "answered" });

  const [conv] = await w.db.select().from(conversations).where(eq(conversations.id, "chat1"));
  expect(conv.messages.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  // Each request resends the growing history unchanged (append-only, needed for thinking blocks and caching).
  expect((requests[2] as { messages: unknown[] }).messages).toHaveLength(5);
});

it("stops on a refusal without running that turn's tools", async () => {
  const w = await makeWorld();
  const { client } = fakeClient([{ stop_reason: "refusal", content: [toolUse("t1", "issue_refund", { order_number: "JP-1042" })] }]);
  const events: AgentEvent[] = [];
  await runTurn({ ctx: { conversationId: "chat1", caller: "CUSTOMER" }, userText: "...", deps: w.deps, client, emit: (e) => events.push(e) });
  expect(events.at(-1)).toEqual({ type: "done", reason: "refusal" });
  expect(w.paypalCalls).toHaveLength(0);
});
