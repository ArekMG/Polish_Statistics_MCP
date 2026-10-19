import { createDbwClient } from "./dbw-client.ts";
import { corsHeaders, createMcpHandler } from "./server.ts";
import { createSupabaseStore, sha256Hex } from "./store.ts";
import { tools } from "./tools.ts";

const store = createSupabaseStore(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const client = createDbwClient({
  apiKey: Deno.env.get("DBW_API_KEY") || undefined,
  limiter: store.limiter,
  cache: store.cache,
});

const handler = createMcpHandler({
  tools,
  context: { client, cache: store.cache },
  limiter: store.limiter,
  accessToken: Deno.env.get("MCP_ACCESS_TOKEN") || undefined,
  // The key itself is never stored; budgets are tracked under a hash of it.
  contextForDbwKey: async (dbwKey) => ({
    client: createDbwClient({
      apiKey: dbwKey,
      userKey: { budgetId: `dbwkey-${(await sha256Hex(dbwKey)).slice(0, 24)}` },
      limiter: store.limiter,
      cache: store.cache,
    }),
    cache: store.cache,
  }),
});

Deno.serve(async (req: Request) => {
  try {
    return await handler(req);
  } catch (err) {
    console.error("unhandled MCP request error", err);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error." } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
