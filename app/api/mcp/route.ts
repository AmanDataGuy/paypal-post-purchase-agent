/**
 * # route.ts (/api/mcp) - MCP Streamable HTTP endpoint for buyer AI agents (Claude Desktop, scripts, etc.)
 */
import { handleMcp } from "@/lib/mcp";
import { realDeps } from "@/lib/deps";

const handle = (req: Request) => handleMcp(req, realDeps);
export { handle as GET, handle as POST, handle as DELETE };
