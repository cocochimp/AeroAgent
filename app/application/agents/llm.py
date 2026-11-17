"""DeepSeek（OpenAI 兼容）客户端与测试用 FakeLLM。任何异常都抛 LLMError，由调用方降级。"""
import json
import httpx
from pydantic import BaseModel, ValidationError
from app import config as S
from app.application.agents.models import SchemeOutput, SubQuery


class LLMError(Exception):
    """统一表示模型调用和响应解析失败；上层据此触发规则降级。"""
    pass


class LLMNotConfigured(LLMError):
    """表示在线模型缺少必要配置；与运行时调用异常区分以便启动检查。"""
    pass


class _Intents(BaseModel):
    sub_queries: list[SubQuery]


class DeepSeekClient:
    """封装 OpenAI 兼容模型调用；业务方法失败时返回降级信号，底层协议错误统一抛出。"""
    def __init__(self, transport=None):
        cfg = S.get()["llm"]
        self.model = cfg["model"]
        self.http = httpx.Client(base_url=cfg["base_url"], timeout=cfg["timeout"], transport=transport,
                                 headers={"Authorization": f"Bearer {cfg['api_key']}"})
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}

    def chat(self, messages, tools=None, json_mode=False) -> dict:
        """发送低温聊天请求并累计 Token 用量；网络、状态和响应结构异常统一转换为模型错误。"""
        body = {"model": self.model, "messages": messages, "temperature": 0}
        if tools:
            body["tools"] = tools
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            r = self.http.post("/chat/completions", json=body)
            r.raise_for_status()
            payload = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise LLMError(f"{type(e).__name__}: {e}") from e
        u = payload.get("usage", {})
        self.usage["calls"] += 1
        self.usage["prompt_tokens"] += u.get("prompt_tokens", 0)
        self.usage["completion_tokens"] += u.get("completion_tokens", 0)
        try:
            return payload["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"响应格式异常：{type(e).__name__}") from e

    def _json(self, system, user) -> dict:
        msg = self.chat([{"role": "system", "content": system}, {"role": "user", "content": user}], json_mode=True)
        try:
            out = json.loads(msg.get("content") or "{}")
        except json.JSONDecodeError as e:
            raise LLMError(f"JSON 解析失败：{e}") from e
        if not isinstance(out, dict):
            raise LLMError("JSON 顶层必须是对象")
        return out

    def react(self, messages, tools=None) -> dict:
        """把首个工具调用转换为 ReAct 动作；没有工具调用时以 finish 收束，参数 JSON 留待 Schema 校验。"""
        from app.application.agents.tools import llm_specs
        msg = self.chat(messages, tools=tools or llm_specs())
        calls = msg.get("tool_calls") or []
        if not calls:
            return {"thought": msg.get("content") or "", "action": "finish", "args": {}}
        fn = calls[0]["function"]
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {"_raw": fn.get("arguments")}
        return {"thought": msg.get("content") or "", "action": fn["name"], "args": args}

    def parse_intents(self, question, ctx, rule_subs):
        """让模型补充拆分乘客子诉求；任何模型或 Schema 失败都返回空结果并保留规则解析。"""
        try:
            out = self._json(
                "把乘客的退改签诉求拆成子诉求，输出 JSON：{\"sub_queries\":[{\"intent\":\"CHANGE|REFUND|POLICY|STATUS\","
                "\"text\":\"子诉求原文\",\"target_date\":\"改签目标日期原文或null\"}]}。不要编造日期。",
                f"上一轮意图：{ctx.get('last_intent')}\n乘客：{question}")
            subs = _Intents.model_validate(out).sub_queries
        except (LLMError, ValidationError):
            return None
        from app.application.agents.understanding import resolve_date
        for s in subs:
            if s.target_date:
                s.target_date = resolve_date(s.target_date) or s.target_date
        return subs

    def summarize(self, turns):
        """生成保留订单、日期和金额的对话摘要；失败时由调用方使用本地摘要。"""
        try:
            return self._json("把对话压缩成一句话摘要，保留订单、日期、金额。输出 {\"summary\": \"...\"}",
                              json.dumps(turns, ensure_ascii=False)).get("summary")
        except LLMError:
            return None

    def write_scheme(self, draft: SchemeOutput, results, feedback, context):
        """润色模板方案文案；保留原结构化选项和分段文本，失败则不覆盖模板。"""
        prompt = (f"上下文：\n{json.dumps({k: v['text'] for k, v in context.get('blocks', {}).items()}, ensure_ascii=False)}\n"
                  f"方案草稿：{draft.model_dump_json()}\n"
                  f"上次校验的问题：{feedback}\n"
                  "请把 text 改写得更自然，金额必须与草稿逐字一致，不得新增规则里没有的承诺。输出 {\"text\": \"...\"}")
        try:
            out = self._json("你是航空公司退改签客服，只能依据给定规则和金额作答。", prompt)
            return SchemeOutput(options=draft.options, text=out["text"], texts=draft.texts)
        except (LLMError, KeyError, ValidationError):
            return None

    def fact_check(self, sentences, corpus):
        """用模型辅助发现无规则依据的句子；失败时不阻断本地确定性校验。"""
        try:
            out = self._json("判断每句话能否在规则原文中找到依据。输出 {\"unsupported\": [\"无依据的句子\"]}",
                             f"规则原文：{corpus}\n句子：{json.dumps(sentences, ensure_ascii=False)}")
            return [s for s in out.get("unsupported", []) if s in sentences]
        except LLMError:
            return None


class FakeLLM:
    """按脚本回放 react()；其余方法返回 None，让调用方走规则逻辑。"""

    def __init__(self, react=None, scheme_texts=None):
        self.script = list(react or [])
        self.scheme_texts = list(scheme_texts or [])   # 每次 write_scheme 取一个；None 表示用模板
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}

    def react(self, messages, tools=None):
        """按脚本依次返回动作或抛出预设异常；用于确定性测试模型降级和重试。"""
        self.usage["calls"] += 1
        if not self.script:
            raise LLMError("脚本已用完")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def parse_intents(self, *a):
        """返回空结果；让意图解析测试始终走本地规则。"""
        return None

    def summarize(self, *a):
        """返回空摘要；让记忆模块使用确定性降级实现。"""
        return None

    def write_scheme(self, draft, *a):
        """按脚本返回替换文案；无剩余文案时保留模板方案。"""
        text = self.scheme_texts.pop(0) if self.scheme_texts else None
        return SchemeOutput(options=draft.options, text=text, texts=draft.texts) if text else None

    def fact_check(self, *a):
        """返回空核查结果；避免测试中的外部模型参与事实校验。"""
        return None


def get_client(mode: str):
    """按运行模式创建决策引擎；统一在线与离线客户端的构造入口。"""
    from app.adapters.outbound.llm.factory import create_decision_engine
    return create_decision_engine(mode)
