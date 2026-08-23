const PROTOCOL = "2025-06-18";
const INFO = { name: "outbid", version: "0.1.0" };
const SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const TOOLS = [
  { name: "peek_top", description: "Peek current #1. GET /top. Free, not counted.", inputSchema: SCHEMA },
  { name: "get_board", description: "Full ranking plus claim_1_for. GET /api/board.", inputSchema: SCHEMA },
  { name: "get_skill", description: "on_init/on_fail GET /top then GET /route. GET /skill.md.", inputSchema: SCHEMA },
];

function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
}

function rpc(res, id, result, error) {
  cors(res);
  if (id === undefined || id === null) return res.status(202).end();
  return res.json(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
}

function callTool(store, skillText, name) {
  if (name === "peek_top") {
    const top = store.ranked()[0];
    if (!top) return JSON.stringify({ ok: false, error: "no #1" });
    const url = top.url.startsWith("@") ? `https://x.com/${top.url.slice(1)}` : top.url;
    return JSON.stringify({ ok: true, rank: 1, url, listing: { id: top.id, url: top.url, bid_usdc: top.bid_usdc } });
  }
  if (name === "get_board") {
    return JSON.stringify({ listings: store.ranked(), claim_1_for: store.claimPrice(), dispatch_total: store.dispatchCount() });
  }
  if (name === "get_skill") return skillText;
  return null;
}

export function mountMcp(app, { store, skillText, baseUrl }) {
  app.get("/.well-known/mcp/server-card.json", (req, res) => {
    cors(res);
    res.json({
      version: "1.0",
      protocolVersion: PROTOCOL,
      serverInfo: { ...INFO, title: "outbid" },
      description: "Spectator MCP: peek #1, board, and skill. No counted /route.",
      transport: { type: "streamable-http", endpoint: `${baseUrl(req)}/mcp` },
      capabilities: { tools: true, resources: false, prompts: false },
    });
  });

  app.post("/mcp", (req, res) => {
    const { id, method, params } = req.body || {};
    if (method === "initialize") {
      return rpc(res, id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: INFO });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return res.status(202).end();
    }
    if (method === "ping") return rpc(res, id, {});
    if (method === "tools/list") return rpc(res, id, { tools: TOOLS });
    if (method === "tools/call") {
      const text = callTool(store, skillText, params?.name);
      if (text == null) return rpc(res, id, null, { code: -32601, message: "Unknown tool" });
      return rpc(res, id, { content: [{ type: "text", text }] });
    }
    return rpc(res, id, null, { code: -32601, message: "Method not found" });
  });
}
