import { isToolError, ToolError } from "./errors.ts";
import type { RateLimiter, RateRule } from "./store.ts";
import type { ToolContext, ToolDefinition } from "./tools.ts";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "dbw-statistics-poland", title: "Statistics Poland DBW", version: "1.1.0" };
const MAX_BODY_BYTES = 64 * 1024;

const INSTRUCTIONS =
  "Tools for the Statistics Poland Knowledge Databases (DBW). Typical flow: search_areas -> find_variables -> " +
  "get_variable_metadata / list_sections_and_periods -> get_section_dimensions -> estimate_data_size -> " +
  "preview_data -> get_data_page or get_complete_data. For several years or periods use get_data_series (one call, " +
  "optional levels/position_ids filter, format 'wide' for a ready table) instead of many single-period calls. " +
  "DBW requests are a shared, limited budget: check quota_status before large downloads; downloaded data is cached. " +
  "All ids are DBW integers. Errors include a code and a hint.";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Retry-After",
};

export type ServerDeps = {
  tools: ToolDefinition[];
  context: ToolContext;
  limiter: RateLimiter;
  accessToken?: string;
  clientRules?: (clientId: string) => RateRule[];
};

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const defaultClientRules = (clientId: string): RateRule[] => [
  { bucket: `client:${clientId}:60s`, windowSeconds: 60, limit: 60 },
  { bucket: `client:${clientId}:1h`, windowSeconds: 3600, limit: 600 },
];

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

function toolResult(structured: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function toolErrorResult(err: ToolError) {
  const text = `ERROR [${err.code}]: ${err.message}` + (err.hint ? ` Hint: ${err.hint}` : "") +
    (err.retryAfterSeconds !== undefined ? ` Retry after ${err.retryAfterSeconds}s.` : "");
  return {
    content: [{ type: "text", text }],
    structuredContent: { error: err.toJSON() },
    isError: true,
  };
}

function toolListing(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));
}

async function callTool(deps: ServerDeps, params: Record<string, unknown>) {
  const tool = deps.tools.find((t) => t.name === params.name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
  const args = params.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args) || args === null) {
    return { result: toolErrorResult(new ToolError("INVALID_ARGUMENT", "Tool arguments must be an object.")) };
  }
  try {
    return { result: toolResult(await tool.handler(args as Record<string, unknown>, deps.context)) };
  } catch (err) {
    if (isToolError(err)) return { result: toolErrorResult(err) };
    console.error(`tool ${tool.name} failed`, err);
    return {
      result: toolErrorResult(
        new ToolError("INTERNAL_ERROR", "The server hit an unexpected problem running this tool.", { hint: "Retry once." }),
      ),
    };
  }
}

async function handleMessage(deps: ServerDeps, msg: JsonRpcMessage): Promise<unknown | undefined> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  const id = (isRequest ? msg.id : null) as JsonRpcId;
  if (msg.jsonrpc !== "2.0" || (typeof msg.method !== "string" && msg.result === undefined && msg.error === undefined)) {
    return rpcError(id, -32600, "Invalid JSON-RPC 2.0 message.");
  }
  if (typeof msg.method !== "string") return undefined;
  if (!isRequest) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Request id must be a string or number.");

  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolListing(deps.tools) } };
    case "tools/call": {
      const out = await callTool(deps, params);
      return "error" in out ? { jsonrpc: "2.0", id, error: out.error } : { jsonrpc: "2.0", id, result: out.result };
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export function createMcpHandler(deps: ServerDeps) {
  const rulesFor = deps.clientRules ?? defaultClientRules;

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

    if (deps.accessToken) {
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      if (!token || !timingSafeEqual(token, deps.accessToken)) {
        return json(rpcError(null, -32001, "Unauthorized: send the server access token as 'Authorization: Bearer <token>'."), 401, {
          "WWW-Authenticate": 'Bearer realm="dbw-mcp"',
        });
      }
    }

    if (req.method !== "POST") {
      return json(
        rpcError(null, -32000, "This MCP server uses Streamable HTTP in stateless JSON mode: send JSON-RPC messages with POST."),
        405,
        { Allow: "POST, OPTIONS" },
      );
    }

    const protocolHeader = req.headers.get("mcp-protocol-version");
    if (protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolHeader)) {
      return json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${protocolHeader}.`), 400);
    }

    const clientId = deps.accessToken
      ? `token-${(await sha256Hex(req.headers.get("authorization") ?? "")).slice(0, 16)}`
      : `ip-${clientIp(req)}`;
    const decision = await deps.limiter.consume(rulesFor(clientId));
    if (!decision.allowed) {
      return json(
        rpcError(null, -32029, `Rate limit exceeded for this client. Retry after ${decision.retryAfterSeconds}s.`, {
          retry_after_seconds: decision.retryAfterSeconds,
        }),
        429,
        { "Retry-After": String(decision.retryAfterSeconds) },
      );
    }

    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json(rpcError(null, -32600, "Request body too large."), 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(rpcError(null, -32700, "Parse error: body must be valid JSON."), 400);
    }

    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as unknown[];
    if (messages.length === 0) return json(rpcError(null, -32600, "Empty batch."), 400);

    const responses: unknown[] = [];
    for (const m of messages) {
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        responses.push(rpcError(null, -32600, "Invalid JSON-RPC 2.0 message."));
        continue;
      }
      const out = await handleMessage(deps, m as JsonRpcMessage);
      if (out !== undefined) responses.push(out);
    }

    if (responses.length === 0) return new Response(null, { status: 202, headers: corsHeaders });
    return json(batch ? responses : responses[0]);
  };
}
