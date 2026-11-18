import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const { parseNativeCompletion, fetchNativeChat, createNativeConversationStore, nativeOrderBindingStatus } = globalThis.AeroAgentClient;

test("shows current order binding and case state without stale copy", () => {
  assert.match(nativeOrderBindingStatus(null), /尚未创建案件/);
  assert.match(nativeOrderBindingStatus("case_1"), /case_1/);
  assert.doesNotMatch(nativeOrderBindingStatus("case_1"), /尚未创建案件/);
});

test("parses native DeepSeek text, quotes, and resumable case metadata", () => {
  const parsed = parseNativeCompletion(`已生成方案\n\n\`\`\`aeroagent-quote\n{"quote_id":"q1","case_id":"case_1","action":"REFUND","amount":698,"currency":"CNY"}\n\`\`\`\n\`\`\`aeroagent-case\n{"case_id":"case_1","user_id":"u_zhang"}\n\`\`\``);
  assert.equal(parsed.text, "已生成方案");
  assert.equal(parsed.caseId, "case_1");
  assert.equal(parsed.quotes[0].quote_id, "q1");
});

test("uses explicit real DeepSeek mode and forwards user, order, and case ownership", async () => {
  const requests = [];
  const result = await fetchNativeChat({
    message: "11.23 改签到下周四", orderId: "ORD1", caseId: "case_1", userId: "u_li",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "好的" } }] }) };
    },
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, "http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(body.model, "aeroagent-deepseek");
  assert.equal(body.metadata.user_id, "u_li");
  assert.equal(body.metadata.selected_order_id, "ORD1");
  assert.match(body.messages[0].content, /```aeroagent-case/);
  assert.match(body.messages[0].content, /case_1/);
  assert.equal(body.messages.at(-1).content, "11.23 改签到下周四");
  assert.equal(result.caseId, null);
});

test("surfaces strict provider failures with retry and case recovery metadata", async () => {
  await assert.rejects(fetchNativeChat({ message: "退票", fetchImpl: async () => ({
    ok: false, status: 503, json: async () => ({ detail: { code: "LLM_UNAVAILABLE",
      message: "DeepSeek 暂不可用", details: { retryable: true, case_id: "case_9" } } }),
  }) }), (error) => {
    assert.equal(error.code, "LLM_UNAVAILABLE");
    assert.equal(error.retryable, true);
    assert.equal(error.caseId, "case_9");
    assert.match(error.message, /DeepSeek 暂不可用/);
    return true;
  });
});

test("rejects malformed native completion responses instead of substituting mock text", async () => {
  await assert.rejects(fetchNativeChat({ message: "退票", fetchImpl: async () => ({
    ok: true, json: async () => ({ choices: [] }),
  }) }), /DeepSeek 响应格式不正确/);
});

test("isolates native conversation state and deduplicates adjacent retry messages", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = createNativeConversationStore({ storage });
  store.patch("u_zhang", { caseId: "case_1", draft: "草稿", quotes: [] });
  store.append("u_zhang", { role: "user", text: "退票" });
  store.append("u_zhang", { role: "user", text: "退票" });
  store.append("u_zhang", { role: "assistant", text: "可以退票" });
  assert.equal(store.get("u_zhang").messages.length, 2);
  assert.equal(store.get("u_zhang").caseId, "case_1");
  assert.equal(store.get("u_li").messages.length, 0);
  assert.equal(store.get("u_li").caseId, null);
  const restored = createNativeConversationStore({ storage });
  assert.deepEqual(restored.get("u_zhang").messages, store.get("u_zhang").messages);
  restored.reset("u_li");
  assert.equal(restored.get("u_zhang").messages.length, 2);
  restored.reset("u_zhang");
  assert.deepEqual(restored.get("u_zhang"), { caseId: null, messages: [], draft: "", quotes: [] });
});
