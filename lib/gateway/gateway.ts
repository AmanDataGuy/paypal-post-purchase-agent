/**
 * # gateway.ts - the only path from an AI tool call to a side effect
 *
 * - Validates input against the tool's schema (the trust boundary: never trust model or buyer-agent input).
 * - Runs the handler, which applies verification and the policy engine.
 * - Writes an audit row for every call, including failures, then returns a compact result.
 */
import { schemas, handlers, type Ctx, type Deps, type ToolName, type ToolResult } from "./tools";
import { toolCalls } from "../db/schema";
import { PayPalError } from "../paypal/client";

const isTool = (name: string): name is ToolName => Object.hasOwn(schemas, name);

// Run one tool call end to end and record it.
export async function execute(name: string, rawInput: unknown, ctx: Ctx, deps: Deps): Promise<ToolResult> {
  const started = Date.now();
  let result: ToolResult;
  if (!isTool(name)) {
    result = { ok: false, message: `Unknown tool ${name}.` };
  } else {
    const parsed = schemas[name].safeParse(rawInput);
    if (!parsed.success) {
      result = { ok: false, message: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
    } else {
      try {
        result = await (handlers[name] as (i: unknown, c: Ctx, d: Deps) => Promise<ToolResult>)(parsed.data, ctx, deps);
      } catch (e) {
        // PayPal failures go back as plain facts. Anything else is a bug: log the detail, return nothing internal
        // (SQL text, ids) to the model or a buyer agent.
        if (e instanceof PayPalError)
          result = { ok: false, message: `PayPal could not complete this (${e.code}). Offer a hand-off to the shop.`, data: { debug_id: e.debugId } };
        else {
          console.error(`tool ${name} failed`, e);
          result = { ok: false, message: "Internal error. Offer a hand-off to the shop." };
        }
      }
    }
  }
  await audit(deps, name, rawInput, ctx, result, started);
  return result;
}

// Write the audit row that powers the console's trace and the eval assertions.
async function audit(deps: Deps, tool: string, input: unknown, ctx: Ctx, r: ToolResult, started: number) {
  await deps.db.insert(toolCalls).values({
    conversationId: ctx.conversationId,
    caller: ctx.caller,
    tool,
    input: input ?? {},
    decisionKind: r.decision?.kind,
    decisionReason: r.decision?.reason,
    ok: r.ok ? 1 : 0,
    result: r,
    ms: Date.now() - started,
  });
}
