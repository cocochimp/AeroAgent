export class ApiError extends Error {
  constructor(message, { status = 0, body = {}, path = "" } = {}) {
    super(message);
    this.name = status ? "ApiError" : "AbortError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export function tokenFor(userId, admin = false) { return `${admin ? "demo-admin" : "demo"}:${userId}`; }

export function parseSSEBlock(block) {
  let id = "";
  let type = "message";
  const data = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try { return { id, type, data: JSON.parse(data.join("\n")) }; }
  catch { return { id, type, data: { message: data.join("\n") } }; }
}

export function newRequestId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Direct JSON/SSE transport for the existing v1 API; no business calculations live here. */
export function createApi({ baseUrl = globalThis.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000",
  fetchImpl = globalThis.fetch } = {}) {
  const root = `${String(baseUrl).replace(/\/+$/, "")}/api/v1`;

  async function request(path, { method = "GET", body, userId = "u_zhang", admin = false, signal, headers = {} } = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      method, signal,
      headers: { Authorization: `Bearer ${tokenFor(userId, admin)}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || payload?.detail?.message ||
        (typeof payload?.detail === "string" ? payload.detail : `请求失败 (${response.status})`);
      throw new ApiError(message, { status: response.status, body: payload, path });
    }
    return payload;
  }

  async function stream(path, { userId = "u_zhang", admin = false, signal, onEvent,
    onError = () => {}, retryDelay = 500, cursor = "" } = {}) {
    let lastId = cursor;
    while (!signal?.aborted) {
      try {
        const url = new URL(`${root}${path}`);
        if (lastId) url.searchParams.set("after", lastId);
        const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${tokenFor(userId, admin)}` }, signal });
        if (!response.ok || !response.body) throw new ApiError(`事件连接失败 (${response.status})`, { status: response.status, path });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const event = parseSSEBlock(block);
            if (!event) continue;
            if (event.id) lastId = event.id;
            if (await onEvent(event.type, event.data, event.id)) {
              await reader.cancel().catch(() => {});
              return lastId;
            }
          }
        }
        if (signal?.aborted) return lastId;
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") return lastId;
        onError(error);
        if (error instanceof ApiError && error.status && error.status !== 0) throw error;
      }
      await wait(retryDelay, signal);
    }
    return lastId;
  }

  return {
    request,
    get: (path, options) => request(path, options),
    post: (path, body, options = {}) => request(path, { ...options, method: "POST", body }),
    put: (path, body, options = {}) => request(path, { ...options, method: "PUT", body }),
    stream,
  };
}
