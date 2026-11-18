"""方案生成：模板（规则模式）或 LLM（DeepSeek 模式）。金额一律回填引擎结果。"""
from collections.abc import Mapping, Sequence
import copy

from app.adapters.outbound.sqlite import data
from app.application.agents.models import FeeItem, SchemeOption, SchemeOutput

STATUS_LABEL = {"scheduled": "计划正常", "delayed": "延误", "cancelled": "已取消"}


def _option(r: dict) -> tuple[SchemeOption, str]:
    refs = [x["id"] for x in r["rules"][:1]]
    fee = r["fee"]
    if r.get("error"):
        return (SchemeOption(type=r["intent"], title="暂时无法办理", allowed=False, rule_refs=[], notes=r["error"]),
                f"{r['text']}：{r['error']}。")
    if r["intent"] == "STATUS":
        st = r["status"]
        delay = f"，延误{st['delay_min']}分钟" if st["status"] == "delayed" else ""
        return (SchemeOption(type="STATUS", title="航班状态", notes=STATUS_LABEL[st["status"]]),
                f"航班{st['flight_no']}（{st['date']} {st['dep_time']}）当前{STATUS_LABEL[st['status']]}{delay}。")
    if r["intent"] == "POLICY" or fee is None:
        top = r["rules"][0] if r["rules"] else None
        if not top:
            return SchemeOption(type="POLICY", title="未找到规则", allowed=False), "没有检索到相关规则。"
        return (SchemeOption(type="POLICY", title=top["title"], rule_refs=[top["id"]]),
                f"根据《{top['title']}》：{top['content']}")
    refs = [fee["rule_id"]] if any(x["id"] == fee["rule_id"] for x in r["rules"]) else refs
    if not fee["allowed"]:
        return (SchemeOption(type=r["intent"], title="不可办理", allowed=False, rule_refs=refs, notes=fee["reason"]),
                f"很抱歉，{fee['reason']}（依据规则{refs[0] if refs else ''}）。")
    if r["intent"] == "CHANGE":
        t = fee.get("target")
        if not t:
            # 引擎允许改签但没有给出目标（例如日期仍未确认）：不能生成可办理报价，也不能抛 500。
            return (SchemeOption(type="CHANGE", title="改签目标待确认", allowed=False, rule_refs=refs,
                                 notes=fee.get("reason") or "缺少改签目标日期或航班"),
                    f"改签目标尚未确认：{fee.get('reason') or '请补充目标日期或航班后再计算费用'}。")
        items = [FeeItem(name="改期费", amount=fee.get("change_fee", 0)),
                 FeeItem(name="票面差价", amount=fee.get("fare_diff", 0))]
        from app.application.agents.understanding import format_date_label
        date_label = format_date_label(t["date"])
        head = "因航班非自愿变动，" if fee.get("involuntary") else f"当前处于{fee.get('window_label', '当前')}档，"
        text = (f"{head}改签至{date_label} {t['flight_no']}（{t['dep_time']}）：改期费{fee.get('change_fee', 0)}元，"
                f"票面差价{fee.get('fare_diff', 0)}元，合计需支付{fee.get('total', 0)}元。")
        return (SchemeOption(type="CHANGE", title=f"改签至 {date_label} {t['flight_no']}", fee_items=items,
                             total=fee.get("total", 0), rule_refs=refs), text)
    items = [FeeItem(name="退票费", amount=fee.get("refund_fee", 0)),
             FeeItem(name="机场建设费退还", amount=fee.get("tax", 0))]
    head = "因航班非自愿变动，" if fee.get("involuntary") else f"当前处于{fee.get('window_label', '当前')}档，"
    text = (f"{head}退票：退票费{fee.get('refund_fee', 0)}元，退还机场建设费{fee.get('tax', 0)}元，"
            f"预计退款{fee.get('refund_amount', 0)}元。")
    return (SchemeOption(type="REFUND", title="退票", fee_items=items, total=fee.get("refund_amount", 0),
                         rule_refs=refs), text)


def generate(results: list[dict], feedback: list[str] | None = None, llm=None, context: dict | None = None) -> SchemeOutput:
    """根据工具证据生成只读退改方案；模型仅润色文案，结构化金额始终采用引擎结果。"""
    opts, texts, seen = [], [], set()
    for r in results:
        o, t = _option(r)
        key = (o.type, o.title, o.total)
        if key in seen:                      # 重复子诉求不能变成重复方案
            continue
        seen.add(key)
        opts.append(o)
        texts.append(t)
    out = SchemeOutput(options=opts, text="".join(texts), texts=texts)
    if llm is not None:
        polished = llm.write_scheme(out, results, feedback or [], context or {})
        if polished:
            out = enforce_amounts(polished, out)
    return out


def enforce_amounts(candidate: SchemeOutput, reference: SchemeOutput) -> SchemeOutput:
    """LLM 只负责措辞：结构化字段一律用模板（引擎）值覆盖；子方案文案保留模板版本。"""
    return SchemeOutput(options=reference.options, text=candidate.text, texts=reference.texts)


def ensure_fee_rule(result: dict) -> dict:
    """引擎用到的依据规则若没被检索到，就从规则库补进 rules 头部（返回新字典，不改入参）。"""
    fee = result.get("fee")
    if not fee or result.get("error") or not fee.get("rule_id"):
        return result
    rules = result.get("rules") or []
    if any(x["id"] == fee["rule_id"] for x in rules):
        return result
    rule = data.get_rule(fee["rule_id"])
    return {**result, "rules": [rule] + list(rules)} if rule else result


def _profile_products(profile: Mapping | None) -> Mapping:
    data = (profile or {}).get("data") or {}
    products = data.get("products") or {}
    return products if isinstance(products, Mapping) else {}


def _product_weight(products: Mapping, fare_product: str) -> float:
    value = products.get(fare_product, 0)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def _candidate_rationale(quote: Mapping, cheapest: int, preferred: bool, price_sensitive: bool) -> str:
    """Compose reasons solely from quote fields and explicit profile preferences."""
    target = quote["target"]
    parts = [f"{target['date']} {target['dep_time']} 起飞，{target['cabin']}舱/{target['fare_product']}；"
             f"改期费{quote['change_fee']}元，票面差价{quote['fare_diff']}元，合计{quote['total']}元。"]
    if preferred:
        parts.append(f"符合画像中的 {target['fare_product']} 票种偏好。")
    if quote["total"] == cheapest:
        parts.append("本候选合计最低，符合高价格敏感度偏好。" if price_sensitive else "本候选合计最低。")
    return "".join(parts)


def generate_change_options(quotes: Sequence[Mapping], profile: Mapping | None = None) -> list[dict]:
    """Rank independently priced candidates; never forward provider-written reasons.

    High price sensitivity puts total first. Otherwise an explicit fare-product
    preference is primary and total breaks ties. Every final key is deterministic.
    The returned quote is a deep copy so ranking or presentation cannot mutate it.
    """
    if not 2 <= len(quotes) <= 5:
        raise ValueError("SmartMock 改签报价必须为 2–5 个")
    if any(not quote.get("allowed") for quote in quotes):
        raise ValueError("SmartMock 报价包含不可办理候选，不能生成推荐方案")
    products = _profile_products(profile)
    price_sensitive = ((profile or {}).get("data") or {}).get("price_sensitivity") == "高"

    def sort_key(quote):
        target = quote["target"]
        preference = _product_weight(products, target["fare_product"])
        common = (target["date"], target["dep_time"], quote["candidate_id"])
        return ((quote["total"], -preference, *common) if price_sensitive else
                (-preference, quote["total"], *common))

    ranked = sorted(quotes, key=sort_key)
    cheapest = min(quote["total"] for quote in ranked)
    options = []
    for rank, source in enumerate(ranked, start=1):
        quote = copy.deepcopy(source)
        target = copy.deepcopy(quote["target"])
        preferred = _product_weight(products, target["fare_product"]) > 0
        rationale = _candidate_rationale(quote, cheapest, preferred, price_sensitive)
        options.append({
            "candidate_id": quote["candidate_id"],
            "type": "CHANGE",
            "title": (f"改签至 {target['date']} {target['flight_no']}"
                      f"（{target['dep_time']}，{target['cabin']}舱/{target['fare_product']}）"),
            "allowed": quote["allowed"],
            "target": target,
            "fee_items": [{"name": "改期费", "amount": quote["change_fee"]},
                          {"name": "票面差价", "amount": quote["fare_diff"]}],
            "total": quote["total"],
            "rule_refs": [quote["rule_id"]],
            "rationale": rationale,
            "recommended": rank == 1,
            "rank": rank,
            "quote": quote,
        })
    return options
