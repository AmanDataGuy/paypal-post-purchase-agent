/**
 * # mcp.ts - MCP endpoint logic: lets a buyer's AI agent resolve post-purchase issues with the shop
 *
 * - Exposes the same gateway tools as the chat agent, with caller = BUYER_AGENT (lower auto-refund limit).
 * - There is no LLM of ours in this path: the buyer's agent calls tools, the gateway validates and decides.
 * - One conversation row per MCP session, so verification is scoped to that session.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { conversations } from "./db/schema";
import { execute } from "./gateway/gateway";
import { descriptions, schemas, type Deps, type ToolName } from "./gateway/tools";
import { allow, clientIp } from "./rate-limit";

// shortcut: sessions live in process memory (single Render instance); move to the DB if we ever scale out.
const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; lastSeen: number }>();
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 1000;

// Close sessions idle for 30 minutes, so abandoned agents don't pile up in memory.
function sweep(now: number) {
  for (const [id, s] of sessions)
    if (now - s.lastSeen > IDLE_MS) {
      sessions.delete(id);
      void s.transport.close();
    }
}

const INSTRUCTIONS =
  "Support tools for Juniper & Pine orders paid with PayPal. Call verify_customer first with the store order number and the email used at checkout. Refunds follow the shop's policy and may be sent to the shop owner for approval.";

// Create an MCP server whose tools act for the session's conversation.
function buildServer(conversationId: () => string, getDeps: () => Promise<Deps>) {
  const server = new McpServer({ name: "juniper-and-pine-support", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const name of Object.keys(schemas) as ToolName[]) {
    server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name] }, async (args: unknown) => {
      const r = await execute(name, args, { conversationId: conversationId(), caller: "BUYER_AGENT" }, await getDeps());
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }], isError: !r.ok };
    });
  }
  return server;
}

// Handle one HTTP request to /api/mcp (initialize starts a session; later requests carry mcp-session-id).
export async function handleMcp(req: Request, getDeps: () => Promise<Deps>): Promise<Response> {
  const now = Date.now();
  const sid = req.headers.get("mcp-session-id");
  if (sid) {
    const existing = sessions.get(sid);
    if (!existing) return Response.json({ error: "Unknown or expired MCP session" }, { status: 404 });
    existing.lastSeen = now;
    return existing.transport.handleRequest(req);
  }
  sweep(now);
  if (sessions.size >= MAX_SESSIONS || !allow(`mcp-init:${clientIp(req)}`, 20, 10 * 60_000))
    return Response.json({ error: "Too many sessions. Try again later." }, { status: 429 });
  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: async (id) => {
      sessions.set(id, { transport, lastSeen: Date.now() });
      await (await getDeps()).db.insert(conversations).values({ id, channel: "MCP" });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  await buildServer(() => transport.sessionId!, getDeps).connect(transport);
  return transport.handleRequest(req);
}
