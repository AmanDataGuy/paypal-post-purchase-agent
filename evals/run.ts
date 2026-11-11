/**
 * # run.ts - runs the eval scenarios: a simulated customer vs the real support agent + gateway
 *
 * - `npm run eval -- --k 3 [--only B1,C1]`. With LLM_CHAIN set, the agent runs on that chain and the customer on
 *   EVAL_SIM_CHAIN (free tiers; trials run one at a time to stay under rate limits). Without it, both run on Claude,
 *   which costs real API money (~$0.10 per conversation on Opus 5.5); ask first.
 * - Each trial gets a fresh in-memory world with a fake PayPal, so trials are independent and nothing real moves.
 * - Scored on the end state. Writes evals/reports/<date>.md with pass^1 and pass^k per scenario.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { approvals, refunds, toolCalls } from "../lib/db/schema";
import { chat, runTurnOpenAI } from "../lib/agent/openai-agent";
import { MODEL, runTurn, type AgentEvent } from "../lib/agent/support-agent";
import { fromCents } from "../lib/money";
import { makeWorld } from "../lib/testing";
import { SCENARIOS, type Scenario } from "./scenarios";

const SIM_MODEL = "claude-haiku-5-5";
const MAX_TURNS = 8;
const DONE = "###DONE###";
const arg = (name: string) => process.argv.find((_, i, a) => a[i - 1] === `--${name}`);
const K = Number(arg("k") ?? 3);
const ONLY = arg("only")?.split(",");

const CHAIN = process.env.LLM_CHAIN;
const SIM_CHAIN = process.env.EVAL_SIM_CHAIN ?? "gemini:gemini-3.5-flash-lite";
const client = CHAIN ? undefined : new Anthropic();

// The simulated customer's next message, given the conversation so far (roles flipped: the agent is "user").
async function customerSays(s: Scenario, history: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const system = `You are role-playing a customer in an online shop's support chat. Stay in character and write short, natural messages.
Persona: ${s.persona}
Goal: ${s.goal}
Never mention being an AI or a test. Do not invent order numbers or emails. When your goal is met, cannot be met, or you are told someone will follow up, say a short goodbye and put ${DONE} on its own line.`;
  if (!client) return ((await chat([{ role: "system", content: system }, ...history], { chain: SIM_CHAIN })).message.content ?? "").trim();
  const msg = await client.messages.create({ model: SIM_MODEL, max_tokens: 1024, output_config: { effort: "low" }, system, messages: history });
  return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

// Play one conversation and check the end state. Returns the failure reasons (empty = pass).
async function trial(s: Scenario): Promise<{ failures: string[]; transcript: string }> {
  const w = await makeWorld(s.world);
  const sim: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "(The support chat window has opened. Write your first message.)" }];
  const lines: string[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const said = await customerSays(s, sim);
    sim.push({ role: "assistant", content: said });
    const text = said.replace(DONE, "").trim();
    if (text) lines.push(`CUSTOMER: ${text}`);
    if (!text) break; // a goodbye with a last request ("yes please, bye") still reaches the agent below
    let reply = "";
    const turn = {
      ctx: { conversationId: "chat1", caller: "CUSTOMER" as const },
      userText: text,
      deps: w.deps,
      emit: (e: AgentEvent) => {
        if (e.type === "text") reply += e.delta;
        if (e.type === "tool") lines.push(`  [tool ${e.name} -> ${e.result.decision ? `${e.result.decision.kind}:${e.result.decision.reason}` : e.result.ok ? "ok" : "not ok"}]`);
      },
    };
    await (client ? runTurn({ ...turn, client }) : runTurnOpenAI(turn));
    lines.push(`AGENT: ${reply.trim()}`);
    if (said.includes(DONE)) break;
    sim.push({ role: "user", content: reply.trim() || "(no reply)" });
  }

  const failures: string[] = [];
  const got = (await w.db.select().from(refunds)).map((r) => fromCents(r.amountCents)).sort();
  if (JSON.stringify(got) !== JSON.stringify([...s.expect.refunds].sort()))
    failures.push(`refunds ${JSON.stringify(got)} != expected ${JSON.stringify(s.expect.refunds)}`);
  const pending = (await w.db.select().from(approvals)).length;
  if (s.expect.approvals !== undefined && pending !== s.expect.approvals) failures.push(`approvals ${pending} != ${s.expect.approvals}`);
  const calls = await w.db.select().from(toolCalls);
  for (const t of s.expect.mustCall ?? []) if (!calls.some((c) => c.tool === t && c.ok)) failures.push(`never called ${t} successfully`);
  for (const t of s.expect.mustNotSucceed ?? []) if (calls.some((c) => c.tool === t && c.ok)) failures.push(`${t} succeeded but must not`);
  return { failures, transcript: lines.join("\n") };
}

// pass^k estimator from τ-bench: chance that k fresh trials all pass, given c passes out of n.
const choose = (n: number, k: number): number => (k < 0 || k > n ? 0 : k === 0 ? 1 : (choose(n - 1, k - 1) * n) / k);
const passHatK = (c: number, n: number, k: number) => choose(c, k) / choose(n, k);

async function main() {
  const picked = SCENARIOS.filter((s) => !ONLY || ONLY.some((p) => s.id.startsWith(p)));
  const rows: string[] = [];
  const details: string[] = [];
  let sum1 = 0;
  let sumK = 0;
  let moneyViolations = 0;
  for (const s of picked) {
    // Free tiers allow only a few requests a minute: run trials one at a time there.
    const results = [];
    if (CHAIN) for (let i = 0; i < K; i++) results.push(await trial(s));
    else results.push(...(await Promise.all(Array.from({ length: K }, () => trial(s)))));
    const c = results.filter((r) => r.failures.length === 0).length;
    sum1 += c / K;
    sumK += passHatK(c, K, K);
    moneyViolations += results.filter((r) => r.failures.some((f) => f.startsWith("refunds"))).length;
    rows.push(`| ${s.id} | ${s.category} | ${c}/${K} | ${passHatK(c, K, K).toFixed(2)} |`);
    console.log(`${s.id}: ${c}/${K}`);
    results.forEach((r, i) => details.push(`### ${s.id} trial ${i + 1}: ${r.failures.length ? `FAIL (${r.failures.join("; ")})` : "pass"}\n\n\`\`\`\n${r.transcript}\n\`\`\``));
  }
  const report = `# Eval report ${new Date().toISOString()}

Agent: ${CHAIN ? `${CHAIN} (first that answers)` : `${MODEL} (effort medium)`} · simulated customer: ${CHAIN ? SIM_CHAIN : SIM_MODEL} · k = ${K} trials per scenario · world: in-memory DB + fake PayPal

| Scenario | Category | Passed | pass^${K} |
|---|---|---|---|
${rows.join("\n")}

**Suite pass^1 = ${(sum1 / picked.length).toFixed(2)} · pass^${K} = ${(sumK / picked.length).toFixed(2)} · trials with wrong money movement = ${moneyViolations}**

${details.join("\n\n")}
`;
  mkdirSync("evals/reports", { recursive: true });
  const file = `evals/reports/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  writeFileSync(file, report);
  console.log(`\npass^1 ${(sum1 / picked.length).toFixed(2)} · pass^${K} ${(sumK / picked.length).toFixed(2)} · report: ${file}`);
  process.exit(moneyViolations ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
