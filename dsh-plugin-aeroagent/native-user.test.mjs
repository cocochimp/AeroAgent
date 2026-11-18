import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const {
  NATIVE_DEMO_USERS,
  createNativeUserStore,
  createNativeWatchStore,
  nativeSlotsApply,
} = globalThis.AeroAgentClient;

function childrenOf(node) {
  if (!node || typeof node !== "object") return [];
  const children = node.props?.children;
  return Array.isArray(children) ? children.flat(Infinity) : children ? [children] : [];
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of childrenOf(node)) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return childrenOf(node).map(textOf).join("");
}

function nativeContext(calls) {
  return {
    slots: {
      inject(name, factory) { calls.push({ type: "inject", name }); factory(); },
      register(options, component) { calls.push({ type: "register", ...options, component }); },
    },
    sidebarRightTabs: { register() {} },
    sidebarRight: { openTab() {} },
    layout: { selectPanel() {} },
  };
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

test("provides the four approved demo profiles in switcher order", () => {
  assert.deepEqual(NATIVE_DEMO_USERS.map(({ user_id, name, tier }) => ({ user_id, name, tier })), [
    { user_id: "u_zhang", name: "张三", tier: "金卡" },
    { user_id: "u_li", name: "李四", tier: "银卡" },
    { user_id: "u_wang", name: "王五", tier: "普卡" },
    { user_id: "u_zhao", name: "赵六", tier: "黑钻" },
  ]);
});

test("switches the active native user and rejects unknown identities", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = createNativeUserStore({ storage });
  const firstSnapshot = store.getSnapshot();
  assert.equal(firstSnapshot.userId, "u_zhang");
  assert.equal(store.getSnapshot(), firstSnapshot);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const next = store.switchUser("u_li");
  assert.equal(next.userId, "u_li");
  assert.equal(next.user.name, "李四");
  assert.equal(next.user.tier, "银卡");
  assert.equal(notifications, 1);
  assert.equal(values.get("aeroagent-native-user"), "u_li");
  assert.throws(() => store.switchUser("u_unknown"), /未知演示用户/);
  assert.equal(store.getSnapshot().userId, "u_li");
  store.switchUser("u_li");
  assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(createNativeUserStore({ storage }).getSnapshot().userId, "u_li");
});

test("aborts active native requests and permanently invalidates stale owners on switching", () => {
  const store = createNativeUserStore({ storage: null });
  const staleOwner = store.captureOwner();
  const controller = store.trackRequest(new AbortController());
  assert.equal(store.isOwnerCurrent(staleOwner), true);
  store.switchUser("u_li");
  assert.equal(controller.signal.aborted, true);
  assert.equal(store.isOwnerCurrent(staleOwner), false);
  const liOwner = store.captureOwner();
  store.switchUser("u_zhang");
  assert.equal(store.isOwnerCurrent(staleOwner), false, "switching back must not revive an old request");
  assert.equal(store.isOwnerCurrent(liOwner), false);
  assert.equal(store.isOwnerCurrent(store.captureOwner()), true);
});

test("keeps native watch snapshots isolated and restorable per user", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const watches = createNativeWatchStore({ storage });
  const zhangWatch = { watch_id: "watch_zhang", target_price: 500 };
  watches.replace("u_zhang", [zhangWatch]);
  watches.replace("u_li", [{ watch_id: "watch_li", target_price: 600 }]);
  assert.deepEqual(watches.get("u_zhang"), [zhangWatch]);
  assert.deepEqual(watches.get("u_li").map((watch) => watch.watch_id), ["watch_li"]);
  assert.deepEqual(watches.get("u_wang"), []);
  assert.match(values.get("aeroagent-native-watches:u_zhang"), /watch_zhang/);
  const restored = createNativeWatchStore({ storage });
  assert.deepEqual(restored.get("u_zhang"), [zhangWatch]);
  restored.replace("u_zhang", []);
  assert.deepEqual(restored.get("u_li").map((watch) => watch.watch_id), ["watch_li"]);
});

test("registers a native footer switcher above the host user area and switches shared state", () => {
  const calls = [];
  const runtime = nativeSlotsApply(nativeContext(calls), React, { storage: null });
  const registration = calls.find((call) => call.name === "sidebar.footer.action" && call.id === "aeroagent-footer");
  assert.ok(registration, "learning navigation and user switcher must share one official footer action");
  const tree = registration.component();
  const select = findNode(tree, (node) => node.type === "select" && node.props?.["aria-label"] === "切换演示用户");
  assert.ok(select);
  assert.equal(select.props.value, "u_zhang");
  for (const label of ["张三", "金卡", "李四", "银卡", "王五", "普卡", "赵六", "黑钻"]) {
    assert.match(textOf(tree), new RegExp(label));
  }
  assert.match(textOf(tree), /推荐.*排序.*费用|费用.*推荐.*排序/);
  select.props.onChange({ target: { value: "u_zhao" } });
  assert.equal(runtime.users.getSnapshot().userId, "u_zhao");
  assert.equal(findNode(registration.component(), (node) => node.props?.["data-native-user"] === "u_zhao")?.props?.["data-native-user"], "u_zhao");
});
