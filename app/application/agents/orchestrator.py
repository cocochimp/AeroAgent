"""LangGraph 状态图：工作一的编排，串起 Query 理解、检索、记忆、生成与校验。

阅读顺序：build_graph() 看节点和边 → 各节点函数 → run_turn()/resume() 看如何驱动与流式输出。
interrupt 注意：节点在 resume 后会从头重新执行，所以 interrupt() 之前不能有副作用。
"""
import sqlite3
import time
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from app.adapters.outbound.sqlite import data
from app.adapters.outbound import retrieval
from app.application.agents import llm as llm_mod, memory, planning as planner, tools, understanding as query
from app.application.agents import proposal as scheme_mod
from app import config as S
from app.application.agents import verification as verify_mod
from app.application.agents.models import AgentState, ParsedQuery
from app.application.agents.main_agent import MainServiceAgent
from app.application.agents.solution_agent import ServicingAdvisorAgent

_clients: dict = {}          # session_id -> LLM 客户端（不写进检查点）
_graph = None
_main_agent = MainServiceAgent()
_solution_agent = ServicingAdvisorAgent()


def _llm(state):
    return _clients.get(state["session_id"])


def ev(node, t0, inp=None, out=None, note="", status="ok"):
    """生成统一节点轨迹事件；耗时和输入输出快照用于解释 Agent 执行过程。"""
    return {"node": node, "status": status, "ms": round((time.perf_counter() - t0) * 1000, 1),
            "at": S.now().isoformat(), "input": inp, "output": out, "note": note}


def _qctx(state):
    mem, cl = state.get("memory") or {}, state.get("clarified") or {}
    return {"user_id": state["user_id"], "selected_order_id": cl.get("order_id") or state.get("order_id"),
            "order_stack": mem.get("order_stack", []), "last_intent": mem.get("last_intent"),
            "forced_date": cl.get("target_date"), "forced_intent": cl.get("intent")}


# ---------------- 节点 ----------------
def user_input(state):
    """初始化单轮图状态；清空上一轮的调用、重试和确认数据，避免中断恢复串轮。"""
    t0 = time.perf_counter()
    return {"sub_idx": 0, "calls": [], "results": [], "rounds": 0, "tool_retries": 0, "gate_blocks": 0,
            "retries": 0, "feedback": [], "error_feedback": [], "clarified": {}, "clarify_req": None,
            "clarify_count": 0, "stepped_back": False, "outcome": "", "final": {}, "scheme": {}, "verify": {},
            "confirm": None,
            "trace": [ev("user_input", t0, {"question": state["question"], "order_id": state.get("order_id"),
                                            "mode": state.get("mode")}, None, "接收乘客诉求")]}


def memory_node(state):
    """恢复短期记忆和用户画像；为订单对齐与检索排序提供跨轮上下文。"""
    t0 = time.perf_counter()
    mem = memory.load_session(state["session_id"])
    view = {"order_stack": mem["order_stack"], "summary": mem["summary"], "turns": len(mem["turns"]),
            "last_intent": mem["last_intent"], "boost": memory.profile_boost(state["user_id"])}
    return {"memory": mem, "trace": [ev("memory_node", t0, None, view, "加载短期记忆与用户画像")]}


def order_align(state):
    """把当前诉求对齐到具体订单；只补充展示上下文，不改变订单选择。"""
    t0 = time.perf_counter()
    oid = query.resolve_order(state["question"], _qctx(state))
    out = None
    if oid:
        o = data.get_order(oid)
        out = {"order_id": oid, "airline": o["airline"], "cabin": o["cabin"], "fare_product": o["fare_product"],
               "label": query.order_label(o)}
    return {"trace": [ev("order_align", t0, {"selected": state.get("order_id")}, out,
                         "订单字段对齐" if oid else "未能确定订单", "ok" if oid else "warn")]}


def query_understand(state):
    """解析复合诉求并构建受限上下文；低置信度或缺字段时留下追问请求。"""
    t0 = time.perf_counter()
    p = _main_agent.understand(state["question"], _qctx(state), _llm(state))
    order = data.get_order(p.order_id) if p.order_id else None
    ctx = memory.build_context(order, [], state["memory"], data.get_profile(state["user_id"]))
    note = f"{len(p.sub_queries)} 个子诉求，置信度 {p.confidence}" + ("，需要追问" if p.clarify else "")
    return {"parsed": p.model_dump(), "context": ctx,
            "trace": [ev("query_understand", t0, {"question": state["question"]}, p.model_dump(), note)]}


def clarify(state):
    """中断图等待用户补充关键字段；超过三次仍不明确则转人工，恢复后重置子任务状态。"""
    t0 = time.perf_counter()
    req = state.get("clarify_req") or ParsedQuery.model_validate(state["parsed"]).clarify
    if state.get("clarify_count", 0) >= 3:
        return {"verify": {"errors": ["多次追问仍无法确定诉求"]}, "outcome": "HUMAN",
                "trace": [ev("clarify", t0, req, None, "追问次数已达上限", "error")]}
    answer = interrupt({"kind": "clarify", **req})
    value = answer.get("value") if isinstance(answer, dict) else answer
    return {"clarified": {**(state.get("clarified") or {}), req["field"]: value}, "clarify_req": None,
            "clarify_count": state.get("clarify_count", 0) + 1, "calls": [], "results": [], "sub_idx": 0,
            "rounds": 0, "tool_retries": 0, "gate_blocks": 0, "error_feedback": [], "stepped_back": False,
            "trace": [ev("clarify", t0, req, {"field": req["field"], "value": value}, "已获得乘客补充信息")]}


def agent_node(state):
    """为当前子诉求选择下一步 ReAct 动作；超过轮数上限或模型失败时分别转人工或规则降级。"""
    t0 = time.perf_counter()
    _, sub = planner.current(state)
    rounds = state.get("rounds", 0) + 1
    if rounds > S.get()["planner"]["max_rounds"]:
        a = {"thought": "已达到 ReAct 轮数上限，转人工", "action": "human", "args": {}, "source": "guard"}
    else:
        a = _solution_agent.decide(state, _llm(state))
        done = {call["tool"] for call in state.get("calls") or [] if call.get("ok")}
        if a.get("source") == "llm" and a.get("action") in done:
            # 模型重复点名已成功的工具会空转；按确定性计划推进下一件未完成的事。
            a = {**planner.rule_decide(state), "source": "guard",
                 "guard_reason": f"{a['action']} 已执行成功，按计划推进"}
    note = f"第 {rounds} 轮 → {a['action']}"
    if a.get("source") == "fallback":
        note += "；DeepSeek 调用失败，已回退规则决策"
    upd = {"rounds": rounds, "next_action": a,
           "trace": [ev("agent_node", t0, {"sub_query": sub.text, "intent": sub.intent, "round": rounds}, a,
                        note, "warn" if a.get("source") == "fallback" else "ok")]}
    if a["action"] == "clarify":
        upd["clarify_req"] = {"field": "target_date", "options": query.date_options(),
                              "question": f"「{sub.target_date}」无法确定具体日期，想改签到哪一天？"}
    if a["action"] == "human":
        upd["verify"] = {"errors": [a["thought"]]}
    return upd


def schema_validate(state):
    """校验并清洗工具参数；错误反馈给决策节点重试，未知工具也在此被拦截。"""
    t0 = time.perf_counter()
    a = state["next_action"]
    model, errs = tools.validate(a["action"], a["args"])
    if errs:
        call = {"tool": a["action"], "args": a["args"], "ok": False, "kind": errs[0]["kind"], "errors": errs}
        return {"tool_retries": state.get("tool_retries", 0) + 1, "error_feedback": errs,
                "calls": state["calls"] + [call],
                "trace": [ev("schema_validate", t0, {"tool": a["action"], "args": a["args"]}, errs,
                             f"{errs[0]['kind']}：{errs[0]['message']}", "error")]}
    clean = model.model_dump(exclude_none=True)
    return {"error_feedback": [], "next_action": {**a, "args": clean},
            "trace": [ev("schema_validate", t0, {"tool": a["action"], "args": a["args"]}, clean, "参数校验通过")]}


def checkpoint_gate(state):
    """强制金额计算前先完成规则检索；防止模型跳过依据直接报价。"""
    t0 = time.perf_counter()
    a = state["next_action"]
    done = {c["tool"] for c in state["calls"] if c.get("ok")}
    if a["action"] == "tool_recalc_fee" and "tool_rule_retrieve" not in done:
        fb = [{"field": "plan", "kind": "SKIP_RULE", "message": "计算金额前必须先调用 tool_rule_retrieve 检索规则"}]
        return {"gate_blocks": state.get("gate_blocks", 0) + 1, "error_feedback": fb, "gate_reason": fb[0]["message"],
                "trace": [ev("checkpoint_gate", t0, {"tool": a["action"], "done": sorted(done)}, None,
                             fb[0]["message"], "blocked")]}
    return {"gate_reason": "",
            "trace": [ev("checkpoint_gate", t0, {"tool": a["action"], "done": sorted(done)}, None, "必经节点检查通过")]}


def tool_exec(state):
    """执行已校验的只读工具并记录调用；成功后清零参数重试计数，失败保留结构化错误。"""
    t0 = time.perf_counter()
    a = state["next_action"]
    r = tools.run_tool(a["action"], a["args"], memory.profile_boost(state["user_id"]))
    call = {"tool": a["action"], "args": a["args"], **r}
    upd = {"calls": state["calls"] + [call], "error_feedback": []}
    if r["ok"]:
        upd["tool_retries"] = 0
        note = {"tool_rule_retrieve": lambda o: f"命中 {len(o['rules'])} 条规则（{o['backend']}）",
                "tool_recalc_fee": lambda o: f"引擎计算完成：{o['rule_id']}",
                "tool_flight_status": lambda o: f"航班状态 {o['status']}"}[a["action"]](r["output"])
        upd["trace"] = [ev("tool_exec", t0, {"tool": a["action"], "args": a["args"]}, r["output"], note)]
    else:
        upd["trace"] = [ev("tool_exec", t0, {"tool": a["action"], "args": a["args"]}, r,
                           r.get("error", {}).get("message", "工具执行失败"), "error")]
    return upd


def step_back(state):
    """在规则命中不足时泛化或扩写检索；合并去重后仍受注入条数上限约束。"""
    t0 = time.perf_counter()
    p, sub = planner.current(state)
    last = state["calls"][-1]
    filters = {k: last["args"][k] for k in ("airline", "cabin", "fare_product", "scenario") if last["args"].get(k)}
    boost = memory.profile_boost(state["user_id"])
    q = query.step_back_query(p, sub)
    res, used = retrieval.search(q, filters, boost), "step_back"
    if not res["rules"]:
        q = query.hyde_text(p, sub)
        res, used = retrieval.search(q, filters, boost), "hyde"
    old = last["output"]["rules"]
    merged = old + [x for x in res["rules"] if x["id"] not in {o["id"] for o in old}]
    merged = merged[:S.get()["retrieval"]["k_inject"]]
    calls = state["calls"][:-1] + [{**last, "output": {**last["output"], "rules": merged},
                                    "rewrite": {"type": used, "query": q}}]
    return {"calls": calls, "stepped_back": True,
            "trace": [ev("step_back", t0, {"query": q, "type": used}, [x["id"] for x in merged],
                         f"{'Step-back 泛化' if used == 'step_back' else 'HyDE 扩写'}后共 {len(merged)} 条")]}


def sub_done(state):
    """汇总当前子诉求的规则、航班和费用证据；推进子任务索引并清理临时执行状态。"""
    t0 = time.perf_counter()
    _, sub = planner.current(state)
    get = lambda tool: next((c for c in reversed(state["calls"]) if c["tool"] == tool and c.get("ok")), None)
    err = next((c for c in state["calls"] if c.get("kind") == "ENGINE"), None)
    rr, fs, fee = get("tool_rule_retrieve"), get("tool_flight_status"), get("tool_recalc_fee")
    result = {"intent": sub.intent, "text": sub.text, "target_date": sub.target_date,
              "status": fs["output"] if fs else None,
              "rules": rr["output"]["rules"] if rr else [], "funnel": rr["output"]["funnel"] if rr else [],
              "retrieval": {k: rr["output"][k] for k in ("backend", "degraded")} if rr else None,
              "rewrite": rr.get("rewrite") if rr else None,
              "fee": fee["output"] if fee else None, "error": err["error"]["message"] if err else None,
              "calls": [{k: c.get(k) for k in ("tool", "args", "ok", "kind")} for c in state["calls"]]}
    result = scheme_mod.ensure_fee_rule(result)     # verify 要求引擎依据规则被检索到并被引用
    return {"results": state["results"] + [result], "sub_idx": state["sub_idx"] + 1, "calls": [], "rounds": 0,
            "tool_retries": 0, "gate_blocks": 0, "error_feedback": [], "stepped_back": False,
            "trace": [ev("sub_done", t0, {"sub_query": sub.text}, {"rules": [x["id"] for x in result["rules"]],
                                                                  "fee": result["fee"], "error": result["error"]},
                         f"子诉求完成：{sub.intent}")]}


def tool_scheme_gen(state):
    """根据全部子诉求证据生成只读方案；把校验反馈用于有限次自我修正。"""
    t0 = time.perf_counter()
    p = ParsedQuery.model_validate(state["parsed"])
    order = data.get_order(p.order_id) if p.order_id else None
    rules = [x for r in state["results"] for x in r["rules"]]
    ctx = memory.build_context(order, rules, state["memory"], data.get_profile(state["user_id"]))
    out = scheme_mod.generate(state["results"], state.get("feedback"), _llm(state), ctx)
    return {"scheme": out.model_dump(), "context": ctx,
            "trace": [ev("tool_scheme_gen", t0, {"feedback": state.get("feedback")}, out.model_dump(),
                         f"上下文 {ctx['total']}/{ctx['budget']} tokens，较全量节省 {ctx['saved_pct']}%")]}


def verify_node(state):
    """校验方案与证据的一致性；可选模型事实核查不能替代本地规则校验。"""
    t0 = time.perf_counter()
    c = _llm(state)
    v = verify_mod.check(state["scheme"], state["results"], c.fact_check if c else None)
    return {"verify": v, "trace": [ev("verify_node", t0, None, v, f"置信度 {v['confidence']}",
                                      "ok" if v["passed"] else "error")]}


def retry_node(state):
    """把校验错误反馈给方案生成节点；重试次数由路由上限控制。"""
    t0 = time.perf_counter()
    errs = state["verify"]["errors"]
    return {"retries": state.get("retries", 0) + 1, "feedback": errs,
            "trace": [ev("retry_node", t0, None, errs, f"第 {state.get('retries', 0) + 1} 次自我修正")]}


def human_review(state):
    """生成统一转人工结果；保留方案草稿和失败原因供客服接续。"""
    t0 = time.perf_counter()
    reasons = ((state.get("verify") or {}).get("errors")
               or [e.get("message", "") for e in state.get("error_feedback") or []] or ["无法自动处理"])
    final = {"outcome": "HUMAN", "text": "这个问题我暂时无法给出可靠答复，已为您转接人工客服。",
             "reasons": reasons, "options": [], "draft": state.get("scheme")}
    return {"outcome": "HUMAN", "final": final,
            "trace": [ev("human_review", t0, None, reasons, "转人工", "human")]}


def finish(state):
    """整理最终答复并持久化记忆；只有成功答复才更新用户偏好画像。"""
    t0 = time.perf_counter()
    outcome = state.get("outcome") or "ANSWER"
    p = ParsedQuery.model_validate(state["parsed"]) if state.get("parsed") else None
    if outcome == "ANSWER":
        sc = state["scheme"]
        final = {"outcome": "ANSWER", "text": sc["text"], "options": sc["options"], "verify": state["verify"]}
    else:
        final = state["final"]
    mem = state["memory"]
    if p and p.order_id:
        memory.push_order(mem, p.order_id)
    c = _llm(state)
    memory.add_turn(mem, "user", state["question"], c)
    memory.add_turn(mem, "assistant", final["text"], c)
    if p and p.sub_queries:
        mem["last_intent"] = p.sub_queries[-1].intent
    memory.save_session(state["session_id"], state["user_id"], mem)
    if outcome == "ANSWER" and p and p.order_id:
        order = data.get_order(p.order_id)
        for i, r in enumerate(state["results"]):
            if r["intent"] in ("CHANGE", "REFUND"):
                memory.update_profile(state["user_id"], order, r["intent"],
                                      key=f"{state['session_id']}:{len(mem['turns'])}:{len(mem.get('archive', []))}:{i}")
    return {"outcome": outcome, "final": final, "memory": mem,
            "trace": [ev("finish", t0, None, {"outcome": outcome}, "写入记忆，本轮结束")]}


def _actionable(final):
    return [i for i, o in enumerate(final.get("options", []))
            if o.get("allowed") and o.get("type") in ("CHANGE", "REFUND")]


def await_confirm(state):
    """中断图展示可办理报价；实际确认和交易只能经 Quote API 与独立交易 Agent 处理。"""
    final = state["final"]
    idx = _actionable(final)
    interrupt({"kind": "confirm", "order_id": state["parsed"]["order_id"],
               "options": [{"index": i, **final["options"][i]} for i in idx],
               "message": "请通过 Quote API 确认报价，办理操作不可撤销。"})


# ---------------- 路由 ----------------
def after_understand(state):
    """理解结果需要补充信息时进入追问，否则开始只读决策。"""
    return "clarify" if state["parsed"].get("clarify") else "agent_node"


def after_clarify(state):
    """追问达到上限时转人工，否则重新理解完整诉求。"""
    return "human_review" if state.get("outcome") == "HUMAN" else "query_understand"


def after_agent(state):
    """把决策动作路由到结束、追问、人工或参数校验；未知工具先经校验暴露错误。"""
    a = state["next_action"]["action"]
    if a == "finish":
        return "sub_done"
    if a in ("clarify", "human"):
        return {"clarify": "clarify", "human": "human_review"}[a]
    return "schema_validate"           # 未知工具名也交给校验节点报 UNKNOWN_TOOL


def after_validate(state):
    """参数错误在限额内回到决策节点；超限转人工，成功则检查必经节点。"""
    if state.get("error_feedback"):
        return "human_review" if state["tool_retries"] > S.get()["planner"]["max_tool_retries"] else "agent_node"
    return "checkpoint_gate"


def after_gate(state):
    """门禁拦截在限额内允许重新决策；连续绕过门禁则转人工。"""
    if state.get("gate_reason"):
        return "human_review" if state.get("gate_blocks", 0) > 2 else "agent_node"
    return "tool_exec"


def after_tool(state):
    """工具失败直接收束子诉求；规则不足且问题相关时触发一次检索降级。"""
    last = state["calls"][-1]
    if not last["ok"]:
        return "sub_done"
    p = state["parsed"]
    if (last["tool"] == "tool_rule_retrieve" and not state.get("stepped_back") and (p.get("fare_product") or p.get("airline"))
            and len(last["output"]["rules"]) < S.get()["query"]["step_back_min_hits"]
            and retrieval.has_domain_term(last["args"].get("query", ""))):   # 无关问题不做泛化改写，交给校验转人工
        return "step_back"
    return "agent_node"


def after_sub(state):
    """仍有子诉求则继续决策，全部完成后进入方案生成。"""
    return "agent_node" if state["sub_idx"] < len(state["parsed"]["sub_queries"]) else "tool_scheme_gen"


def after_verify(state):
    """校验通过即完成，未通过则在限额内修正，最终兜底转人工。"""
    if state["verify"]["passed"]:
        return "finish"
    return "retry_node" if state.get("retries", 0) < S.get()["verify"]["max_retries"] else "human_review"


def after_finish(state):
    """存在可办理方案时等待确认；纯问答和人工结果直接结束图。"""
    return "await_confirm" if state["outcome"] == "ANSWER" and _actionable(state["final"]) else END


def build_graph(checkpointer):
    """装配 LangGraph 节点与条件边；检查点由调用方注入，支持中断和恢复。"""
    b = StateGraph(AgentState)
    for fn in (user_input, memory_node, order_align, query_understand, clarify, agent_node, schema_validate,
               checkpoint_gate, tool_exec, step_back, sub_done, tool_scheme_gen, verify_node, retry_node,
               human_review, finish, await_confirm):
        b.add_node(fn.__name__, fn)
    b.add_edge(START, "user_input")
    b.add_edge("user_input", "memory_node")
    b.add_edge("memory_node", "order_align")
    b.add_edge("order_align", "query_understand")
    b.add_conditional_edges("query_understand", after_understand, ["clarify", "agent_node"])
    b.add_conditional_edges("clarify", after_clarify, ["human_review", "query_understand"])
    b.add_conditional_edges("agent_node", after_agent, ["sub_done", "clarify", "human_review", "schema_validate"])
    b.add_conditional_edges("schema_validate", after_validate, ["human_review", "agent_node", "checkpoint_gate"])
    b.add_conditional_edges("checkpoint_gate", after_gate, ["human_review", "agent_node", "tool_exec"])
    b.add_conditional_edges("tool_exec", after_tool, ["sub_done", "step_back", "agent_node"])
    b.add_edge("step_back", "agent_node")
    b.add_conditional_edges("sub_done", after_sub, ["agent_node", "tool_scheme_gen"])
    b.add_edge("tool_scheme_gen", "verify_node")
    b.add_conditional_edges("verify_node", after_verify, ["finish", "retry_node", "human_review"])
    b.add_edge("retry_node", "tool_scheme_gen")
    b.add_edge("human_review", "finish")
    b.add_conditional_edges("finish", after_finish, ["await_confirm", END])
    b.add_edge("await_confirm", END)
    return b.compile(checkpointer=checkpointer)


# ---------------- 驱动 ----------------
def get_graph():
    """惰性创建带 SQLite 检查点的全局图；复用编译结果和数据库连接。"""
    global _graph
    if _graph is None:
        S.VAR_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(S.VAR_DIR / "checkpoints.db", check_same_thread=False)
        _graph = build_graph(SqliteSaver(conn))
    return _graph


def reset_graph():
    """清空全局图和会话客户端缓存；供运行时模式切换或测试隔离使用。"""
    global _graph
    _graph = None
    _clients.clear()


def _cfg(session_id):
    return {"configurable": {"thread_id": session_id}, "recursion_limit": 80}


def pending_interrupt(session_id):
    """读取会话当前待处理中断；兼容不同 LangGraph 版本的中断存储位置。"""
    snap = get_graph().get_state(_cfg(session_id))
    ints = list(getattr(snap, "interrupts", ()) or [i for t in snap.tasks for i in t.interrupts])
    return ints[0].value if ints else None


def _drive(inp, session_id, on_event=None):
    """驱动图直到结束或中断并收集轨迹；返回可序列化快照供 HTTP 与 SSE 使用。"""
    g = get_graph()
    events, pending = [], None
    for chunk in g.stream(inp, _cfg(session_id), stream_mode="updates"):
        for node, upd in chunk.items():
            if node == "__interrupt__":
                pending = upd[0].value
                if on_event:
                    on_event({"type": "interrupt", "payload": pending})
                continue
            for e in (upd or {}).get("trace", []):
                events.append(e)
                if on_event:
                    on_event({"type": "trace", "event": e})
    st = g.get_state(_cfg(session_id)).values
    mem = st.get("memory") or {}
    return {"session_id": session_id, "outcome": st.get("outcome"), "final": st.get("final"),
            "interrupt": pending, "trace": events, "parsed": st.get("parsed"), "context": st.get("context"),
            "results": st.get("results"), "verify": st.get("verify"),
            "retries": st.get("retries", 0),
            "memory": {k: mem.get(k) for k in ("order_stack", "summary", "turns", "last_intent")}}


def _begin_turn(session_id):
    client = _clients[session_id]
    if hasattr(client, "begin_turn"):
        client.begin_turn()


def run_turn(session_id, user_id, message, order_id=None, mode=None, client=None, strict=False, on_event=None):
    """启动一轮完整会话并在整轮持有会话锁；模式仅属于本请求，不写全局配置。"""
    from app.adapters.outbound.llm.factory import create_decision_engine
    mode = mode or S.get()["mode"]
    inp = {"session_id": session_id, "user_id": user_id, "question": message, "order_id": order_id,
           "mode": mode, "strict": bool(strict) and mode == "deepseek"}
    with memory.session_lock(session_id):        # 客户端、预算与整轮图执行共用同一把会话锁
        _clients[session_id] = (create_decision_engine(mode, client=client, strict=strict)
                                if client is not None else llm_mod.get_client(mode, strict=strict))
        _begin_turn(session_id)
        return _drive(inp, session_id, on_event)


def resume(session_id, payload, client=None, mode=None, strict=False, on_event=None):
    """用乘客答复恢复待追问的图；重启后始终以检查点模式重建客户端。"""
    from app.adapters.outbound.llm.factory import create_decision_engine
    with memory.session_lock(session_id):
        pending = pending_interrupt(session_id)
        if pending and pending.get("kind") == "confirm":
            raise ValueError("confirm 中断仅用于报价展示，请通过 Quote API 确认并由独立 TransactionAgent 办理")
        checkpoint = get_graph().get_state(_cfg(session_id)).values
        checkpoint_mode = checkpoint.get("mode", mode or "offline")
        strict = checkpoint.get("strict", strict)
        if client is not None:
            _clients[session_id] = create_decision_engine(checkpoint_mode, client=client, strict=strict)
        elif session_id not in _clients:
            _clients[session_id] = llm_mod.get_client(checkpoint_mode, strict=strict)
        _begin_turn(session_id)
        return _drive(Command(resume=payload), session_id, on_event)
