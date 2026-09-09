export function createJsonRpc(endpoint, { timeout = 30_000 } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("rpc: only http or https endpoints");
  }
  let id = 0;
  return async function rpc(method, params = []) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
      const parsed = await res.json();
      if (parsed.error) throw new Error(`rpc ${method}: ${parsed.error.code} ${parsed.error.message}`);
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  };
}
