import test from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_NAV, LEARNING_NAV, createRouter } from "./web/router.js";

test("uses the approved business and learning navigation order", () => {
  assert.deepEqual(BUSINESS_NAV.map((item) => item.id), ["chat", "orders", "listing", "monitor", "more"]);
  assert.deepEqual(LEARNING_NAV.map((item) => item.id), ["eval", "rules", "data"]);
});

test("aborts a stale loader and never mounts its old page", async () => {
  let releaseChat;
  const chatLoaded = new Promise((resolve) => { releaseChat = resolve; });
  let chatMounted = false;
  let ordersMounted = false;
  let chatSignal;
  const router = createRouter({
    loaders: {
      chat: async () => { await chatLoaded; return { mount: () => { chatMounted = true; } }; },
      orders: async () => ({ mount: () => { ordersMounted = true; } }),
    },
    createContext: (pageId) => ({ pageId }),
  });
  const first = router.navigate("chat");
  chatSignal = router.current.signal;
  const second = router.navigate("orders");
  assert.equal(chatSignal.aborted, true);
  releaseChat();
  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.equal(chatMounted, false);
  assert.equal(ordersMounted, true);
  router.destroy();
});

test("disposes a late mount and suppresses stale errors", async () => {
  let finishMount;
  let disposed = false;
  const errors = [];
  const router = createRouter({
    loaders: {
      chat: async () => ({ mount: async () => { await new Promise((resolve) => { finishMount = resolve; }); return () => { disposed = true; }; } }),
      orders: async () => ({ mount: () => {} }),
      broken: async () => { throw new Error("old view failed"); },
    },
    createContext: (pageId) => ({ pageId }),
    onError: (error) => errors.push(error),
  });
  const first = router.navigate("chat");
  await new Promise((resolve) => setImmediate(resolve));
  await router.navigate("orders");
  finishMount();
  assert.equal(await first, false);
  assert.equal(disposed, true);

  const old = router.navigate("broken");
  await router.navigate("orders", { force: true });
  assert.equal(await old, false);
  assert.deepEqual(errors, []);
  router.destroy();
});
