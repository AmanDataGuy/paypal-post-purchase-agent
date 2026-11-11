/**
 * # mcp.test.ts - a buyer agent's MCP session end to end (JSON-RPC over the Streamable HTTP transport)
 */
import { expect, it } from "vitest";
import { handleMcp } from "./mcp";
import { makeWorld } from "./testing";

it("lets a buyer agent verify, then routes its $38 refund to merchant approval", async () => {
  const w = await makeWorld();
  const getDeps = async () => w.deps;
  let sid = "";
  let id = 0;
  // Send one JSON-RPC message the way an MCP client would.
  const rpc = async (method: string, params: unknown = {}, notify = false) => {
    const res = await handleMcp(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sid && { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }),
        },
        body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }),
      }),
      getDeps,
    );
    sid ||= res.headers.get("mcp-session-id") ?? "";
    return res.status === 202 ? undefined : res.json();
  };
  const call = async (name: string, args: unknown) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "buyer-agent", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  expect(sid).not.toBe("");

  const tools = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
  expect(tools).toEqual(["verify_customer", "get_order_status", "issue_refund", "handoff_to_human"]);

  expect((await call("verify_customer", { order_number: "JP-1042", email: "sam@example.test" })).ok).toBe(true);
  const r = await call("issue_refund", { order_number: "JP-1042", amount: "38.00", reason_code: "NOT_RECEIVED", customer_confirmed: true });
  expect(r.decision).toEqual({ kind: "REQUIRE_APPROVAL", reason: "over_auto_limit" });
  expect(w.refundPosts()).toBe(0);
});
