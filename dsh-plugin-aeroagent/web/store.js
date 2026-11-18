export const DEMO_USERS = Object.freeze([
  { user_id: "u_zhang", name: "张三", tier: "金卡" },
  { user_id: "u_li", name: "李四", tier: "银卡" },
  { user_id: "u_wang", name: "王五", tier: "普卡" },
  { user_id: "u_zhao", name: "赵六", tier: "黑钻" },
]);

const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const blankSession = () => ({ sessionId: `dsh-${newId()}`, caseId: null, selectedOrderId: null, draft: "", messages: [] });

/** Session snapshots and request ownership are always keyed by demo user. */
export function createStore({ storage = globalThis.localStorage, initialUserId = "u_zhang" } = {}) {
  let userId = initialUserId;
  let generation = 0;
  let users = DEMO_USERS.map((user) => ({ ...user }));
  const sessions = new Map();
  const histories = new Map();
  const requests = new Map();
  const listeners = new Set();
  const keyFor = (id) => `aeroagent-dsh-session:${id}`;
  const notify = (type) => listeners.forEach((listener) => listener(type, userId));

  function getSession(id = userId) {
    if (!sessions.has(id)) {
      let restored = null;
      try { restored = JSON.parse(storage?.getItem(keyFor(id)) || "null"); } catch { restored = null; }
      const blank = blankSession();
      sessions.set(id, {
        ...blank,
        sessionId: typeof restored?.sessionId === "string" ? restored.sessionId : blank.sessionId,
        caseId: typeof restored?.caseId === "string" ? restored.caseId : null,
        selectedOrderId: typeof restored?.selectedOrderId === "string" ? restored.selectedOrderId : null,
        draft: typeof restored?.draft === "string" ? restored.draft : "",
        messages: Array.isArray(restored?.messages) ? restored.messages.filter((item) =>
          item && ["user", "assistant", "system"].includes(item.role) && typeof item.text === "string").slice(-100) : [],
      });
    }
    return clone(sessions.get(id));
  }

  function persist(id = userId) {
    try { storage?.setItem(keyFor(id), JSON.stringify(sessions.get(id) || blankSession())); } catch { /* Private mode remains in memory. */ }
  }

  function mutate(id, patch) {
    const next = { ...getSession(id), ...patch };
    sessions.set(id, next);
    persist(id);
    if (id === userId) notify("session");
    return clone(next);
  }

  function abortRequests(id) {
    for (const controller of requests.get(id) || []) controller.abort();
    requests.delete(id);
  }

  function captureOwner() {
    return { userId, sessionId: getSession(userId).sessionId, generation };
  }

  function isOwnerCurrent(owner) {
    return Boolean(owner && owner.generation === generation && owner.userId === userId &&
      owner.sessionId === getSession(userId).sessionId);
  }

  function getHistory(id = userId) {
    if (!histories.has(id)) {
      let restored = [];
      try { restored = JSON.parse(storage?.getItem(`aeroagent-dsh-history:${id}`) || "[]"); } catch { restored = []; }
      histories.set(id, Array.isArray(restored) ? restored.filter((item) => item && typeof item.caseId === "string").slice(0, 20) : []);
    }
    return clone(histories.get(id));
  }

  function persistHistory(id) {
    try { storage?.setItem(`aeroagent-dsh-history:${id}`, JSON.stringify(histories.get(id) || [])); } catch { /* Memory-only fallback. */ }
  }

  return {
    getUserId: () => userId,
    getUsers: () => clone(users),
    getUser: (id = userId) => clone(users.find((user) => user.user_id === id) || { user_id: id, name: id, tier: "演示用户" }),
    setUsers(nextUsers) {
      if (!Array.isArray(nextUsers)) return;
      const valid = nextUsers.filter((user) => user && typeof user.user_id === "string" && typeof user.name === "string");
      if (!valid.length) return;
      const merged = new Map([...users, ...valid].map((user) => [user.user_id, { ...user, tier: String(user.tier || "演示用户") }]));
      users = [...merged.values()];
      notify("users");
    },
    getSession,
    captureOwner,
    isOwnerCurrent,
    patchSession(patch, id = userId) {
      const allowed = {};
      if (Object.hasOwn(patch, "caseId")) allowed.caseId = typeof patch.caseId === "string" ? patch.caseId : null;
      if (Object.hasOwn(patch, "draft")) allowed.draft = String(patch.draft || "");
      if (Object.hasOwn(patch, "selectedOrderId")) allowed.selectedOrderId = typeof patch.selectedOrderId === "string" ? patch.selectedOrderId : null;
      return mutate(id, allowed);
    },
    patchSessionFor(owner, patch) {
      if (!isOwnerCurrent(owner)) return null;
      return this.patchSession(patch, owner.userId);
    },
    selectOrder(orderId, id = userId) { return mutate(id, { selectedOrderId: typeof orderId === "string" ? orderId : null }); },
    selectOrderFor(owner, orderId) {
      if (!isOwnerCurrent(owner)) return null;
      return mutate(owner.userId, { selectedOrderId: typeof orderId === "string" ? orderId : null });
    },
    appendMessage(message, id = userId) {
      if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.text !== "string") return getSession(id);
      const session = getSession(id);
      return mutate(id, { messages: [...session.messages, { role: message.role, text: message.text }].slice(-100) });
    },
    appendMessageFor(owner, message) {
      if (!isOwnerCurrent(owner)) return null;
      if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.text !== "string") return getSession(owner.userId);
      const session = getSession(owner.userId);
      return mutate(owner.userId, { messages: [...session.messages, { role: message.role, text: message.text }].slice(-100) });
    },
    switchUser(nextUserId) {
      if (typeof nextUserId !== "string" || !nextUserId || nextUserId === userId) return;
      if (!users.some((user) => user.user_id === nextUserId)) throw new Error("未知演示用户");
      abortRequests(userId);
      generation += 1;
      userId = nextUserId;
      getSession(userId);
      notify("user");
    },
    newSession() {
      abortRequests(userId);
      generation += 1;
      const previous = getSession();
      if (previous.caseId || previous.messages.length) {
        const history = getHistory().filter((item) => item.caseId !== previous.caseId);
        histories.set(userId, [{ ...previous, draft: "" }, ...history].slice(0, 20));
        persistHistory(userId);
      }
      sessions.set(userId, { ...blankSession(), selectedOrderId: previous.selectedOrderId });
      persist(userId);
      notify("session");
      return getSession();
    },
    getHistory,
    restoreHistory(caseId) {
      const history = getHistory();
      const archived = history.find((item) => item.caseId === caseId);
      if (!archived) return null;
      abortRequests(userId);
      generation += 1;
      const current = getSession();
      const nextHistory = history.filter((item) => item.caseId !== caseId);
      if ((current.caseId && current.caseId !== caseId) || (current.messages.length && current.caseId !== caseId)) {
        nextHistory.unshift({ ...current, draft: "" });
      }
      histories.set(userId, nextHistory.slice(0, 20));
      persistHistory(userId);
      sessions.set(userId, { ...clone(archived), draft: "" });
      persist(userId);
      notify("session");
      return getSession();
    },
    trackRequest(controller, id = userId) {
      if (!requests.has(id)) requests.set(id, new Set());
      requests.get(id).add(controller);
      controller.signal.addEventListener("abort", () => requests.get(id)?.delete(controller), { once: true });
      return controller;
    },
    abortRequests,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
