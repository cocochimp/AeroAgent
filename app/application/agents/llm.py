"""DeepSeek（OpenAI 兼容）客户端与测试用 FakeLLM。任何异常都抛 LLMError，由调用方降级。"""
import json
import httpx
from pydantic import BaseModel, ValidationError
from app import config as S
from app.application.agents.models import SchemeOutput, SubQuery


class LLMError(Exception):
    """统一表示模型调用和响应解析失败；携带可供用户重试的结构化信息。"""
    def __init__(self, message, *, code="LLM_REQUEST_FAILED", retryable=True):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class LLMNotConfigured(LLMError):
    """表示在线模型缺少必要配置；与运行时调用异常区分以便启动检查。"""
    def __init__(self, message):
        super().__init__(message, code="LLM_NOT_CONFIGURED", retryable=False)


class _Intents(BaseModel):
    sub_queries: list[SubQuery]


def _invalid_response(detail: str) -> LLMError:
    return LLMError(f"响应格式异常：{detail}", code="LLM_RESPONSE_INVALID", retryable=True)


class DeepSeekClient:
    """封装 OpenAI 兼容模型调用；业务方法失败时返回降级信号，底层协议错误统一抛出。"""
    def __init__(self, transport=None, *, strict=False):
        cfg = S.get()["llm"]
        self.model = cfg["model"]
        self.strict = strict
        self.http = httpx.Client(base_url=cfg["base_url"], timeout=cfg["timeout"], transport=transport,
                                 headers={"Authorization": f"Bearer {cfg['api_key']}"})
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}

    def _optional_failure(self, exc, message):
        """兼容调用方可使用本地降级；严格调用方必须看到原始模型或响应错误。"""
        if self.strict:
            if isinstance(exc, LLMError):
                raise exc
            raise LLMError(message, code="LLM_RESPONSE_INVALID", retryable=True) from exc
        return None

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
        except httpx.TimeoutException as exc:
            raise LLMError(f"{type(exc).__name__}: {exc}", code="LLM_TIMEOUT", retryable=True) from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            raise LLMError(f"{type(exc).__name__}: {exc}", code="LLM_REQUEST_FAILED",
                           retryable=status in {408, 429} or status >= 500) from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"{type(exc).__name__}: {exc}", code="LLM_REQUEST_FAILED", retryable=True) from exc
        try:
            payload = r.json()
        except ValueError as exc:
            raise _invalid_response(type(exc).__name__) from exc
        if not isinstance(payload, dict):
            raise _invalid_response("顶层必须是对象")
        usage = payload.get("usage", {})
        if not isinstance(usage, dict):
            raise _invalid_response("usage 必须是对象")
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        if any(not isinstance(value, (int, float)) or isinstance(value, bool)
               for value in (prompt_tokens, completion_tokens)):
            raise _invalid_response("usage token 计数必须是数字")
        self.usage["calls"] += 1
        self.usage["prompt_tokens"] += prompt_tokens
        self.usage["completion_tokens"] += completion_tokens
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise _invalid_response("choices 必须是非空对象数组")
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise _invalid_response("message 必须是对象")
        return message

    def _json(self, system, user) -> dict:
        msg = self.chat([{"role": "system", "content": system}, {"role": "user", "content": user}], json_mode=True)
        content = msg.get("content")
        if not isinstance(content, str):
            raise _invalid_response("content 必须是字符串")
        try:
            out = json.loads(content)
        except json.JSONDecodeError as exc:
            raise _invalid_response(f"JSON 解析失败：{exc}") from exc
        if not isinstance(out, dict):
            raise _invalid_response("JSON 顶层必须是对象")
        return out

    def react(self, messages, tools=None) -> dict:
        """把首个工具调用转换为 ReAct 动作；没有工具调用时以 finish 收束，参数 JSON 留待 Schema 校验。"""
        from app.application.agents.tools import llm_specs
        msg = self.chat(messages, tools=tools or llm_specs())
        content = msg.get("content")
        if content is not None and not isinstance(content, str):
            raise _invalid_response("content 必须是字符串或 null")
        calls = msg.get("tool_calls")
        if calls is None:
            calls = []
        if not isinstance(calls, list):
            raise _invalid_response("tool_calls 必须是数组")
        if not calls:
            return {"thought": content or "", "action": "finish", "args": {}}
        if not isinstance(calls[0], dict) or not isinstance(calls[0].get("function"), dict):
            raise _invalid_response("tool_calls[0].function 必须是对象")
        fn = calls[0]["function"]
        name = fn.get("name")
        if not isinstance(name, str) or not name:
            raise _invalid_response("tool_calls[0].function.name 必须是非空字符串")
        raw_args = fn.get("arguments")
        if raw_args is None:
            raw_args = "{}"
        if not isinstance(raw_args, str):
            raise _invalid_response("tool_calls[0].function.arguments 必须是字符串")
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError:
            args = {"_raw": raw_args}
        return {"thought": content or "", "action": name, "args": args}

    def parse_intents(self, question, ctx, rule_subs):
        """让模型补充拆分乘客子诉求；任何模型或 Schema 失败都返回空结果并保留规则解析。"""
        try:
            out = self._json(
                "把乘客的退改签诉求拆成子诉求，输出 JSON：{\"sub_queries\":[{\"intent\":\"CHANGE|REFUND|POLICY|STATUS\","
                "\"text\":\"子诉求原文\",\"target_date\":\"改签目标日期原文或null\"}]}。不要编造日期。",
                f"上一轮意图：{ctx.get('last_intent')}\n乘客：{question}")
            subs = _Intents.model_validate(out).sub_queries
        except (LLMError, ValidationError) as exc:
            return self._optional_failure(exc, "意图拆解响应 Schema 校验失败")
        from app.application.agents.understanding import resolve_date
        for s in subs:
            if s.target_date:
                s.target_date = resolve_date(s.target_date) or s.target_date
        return subs

    def summarize(self, turns):
        """生成保留订单、日期和金额的对话摘要；失败时由调用方使用本地摘要。"""
        try:
            summary = self._json("把对话压缩成一句话摘要，保留订单、日期、金额。输出 {\"summary\": \"...\"}",
                                 json.dumps(turns, ensure_ascii=False)).get("summary")
            if not isinstance(summary, str) or not summary.strip():
                raise _invalid_response("summary 必须是非空字符串")
            return summary
        except LLMError as exc:
            return self._optional_failure(exc, "摘要生成失败")

    def write_scheme(self, draft: SchemeOutput, results, feedback, context):
        """润色模板方案文案；保留原结构化选项和分段文本，失败则不覆盖模板。"""
        prompt = (f"上下文：\n{json.dumps({k: v['text'] for k, v in context.get('blocks', {}).items()}, ensure_ascii=False)}\n"
                  f"方案草稿：{draft.model_dump_json()}\n"
                  f"上次校验的问题：{feedback}\n"
                  "请把 text 改写得更自然，金额必须与草稿逐字一致，不得新增规则里没有的承诺。输出 {\"text\": \"...\"}")
        try:
            out = self._json("你是航空公司退改签客服，只能依据给定规则和金额作答。", prompt)
            return SchemeOutput(options=draft.options, text=out["text"], texts=draft.texts)
        except (LLMError, KeyError, ValidationError) as exc:
            return self._optional_failure(exc, "方案润色响应 Schema 校验失败")

    def fact_check(self, sentences, corpus):
        """用模型辅助发现无规则依据的句子；失败时不阻断本地确定性校验。"""
        try:
            out = self._json("判断每句话能否在规则原文中找到依据。输出 {\"unsupported\": [\"无依据的句子\"]}",
                             f"规则原文：{corpus}\n句子：{json.dumps(sentences, ensure_ascii=False)}")
            return [s for s in out.get("unsupported", []) if s in sentences]
        except LLMError as exc:
            return self._optional_failure(exc, "事实核查失败")


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


def get_client(mode: str, *, strict=False):
    """按运行模式创建决策引擎；统一在线与离线客户端的构造入口。"""
    from app.adapters.outbound.llm.factory import create_decision_engine
    return create_decision_engine(mode, strict=strict)
