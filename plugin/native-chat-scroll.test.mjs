import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const { scrollNativeChatToLatest } = globalThis.AeroAgentClient;

test("scrolls only the native conversation feed to its latest message or quote", () => {
  const calls = [];
  const feed = {
    scrollHeight: 960,
    scrollTo(options) { calls.push(options); },
    focus() { throw new Error("must not steal focus"); },
  };
  scrollNativeChatToLatest(feed);
  assert.deepEqual(calls, [{ top: 960, behavior: "smooth" }]);
});

test("supports host feeds without scrollTo and ignores an unmounted feed", () => {
  const feed = { scrollHeight: 420, scrollTop: 0 };
  scrollNativeChatToLatest(feed);
  assert.equal(feed.scrollTop, 420);
  assert.doesNotThrow(() => scrollNativeChatToLatest(null));
});
