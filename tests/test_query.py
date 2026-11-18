from datetime import datetime, timezone

import pytest

from app import config as S
from app.adapters.outbound.sqlite import data
from app.application.agents import understanding as query
from app.application.agents.models import SubQuery

D = "20260926"


def ctx(**kw):
    base = {"user_id": "u_zhang", "selected_order_id": None, "order_stack": [], "last_intent": None}
    return {**base, **kw}


def setup_function(_):
    data.init()


def test_resolve_dates():
    assert query.resolve_date("大后天") == "2026-09-29"
    assert query.resolve_date("下周六") == "2026-10-03"
    assert query.resolve_date("10月3号") == "2026-10-03"
    assert query.resolve_date("2026-10-05") == "2026-10-05"
    assert query.resolve_date("下个月初") is None


def test_dotted_date_uses_next_future_occurrence():
    assert query.resolve_date("11.23") == "2026-11-23"
    assert query.find_date("改到11.23") == "2026-11-23"


def test_leap_day_search_crosses_non_leap_century():
    S.set_now(datetime(2096, 3, 1, 10, 0))
    assert query.resolve_date("2.29") == "2104-02-29"


def test_dotted_date_rolls_into_next_year():
    S.set_now(datetime(2026, 12, 30, 10, 0))
    assert query.resolve_date("1.2") == "2027-01-02"


def test_impossible_dotted_date_is_never_guessed():
    assert query.resolve_date("2.30") is None
    p = query.understand("改到2.30", ctx(selected_order_id=f"ORD{D}001"))
    assert p.sub_queries[0].target_date == "2.30"


def test_dates_are_strictly_in_the_shanghai_future():
    S.set_now(datetime(2026, 11, 23, 16, 30, tzinfo=timezone.utc))  # 上海已是 11 月 24 日
    assert query.resolve_date("11.24") == "2027-11-24"
    assert query.resolve_date("2026-11-24") is None
    assert query.resolve_date("11.25") == "2026-11-25"


def test_today_is_not_a_target_and_month_day_uses_next_occurrence():
    assert query.resolve_date("今天") is None
    assert query.resolve_date("2026-09-26") is None
    assert query.resolve_date("2026-09-25") is None
    assert query.resolve_date("9月26日") == "2027-09-26"
    assert query.resolve_date("9.25") == "2027-09-25"


def test_rejected_past_iso_is_not_reinserted_by_find_date():
    assert query.find_date("改到2026-09-26") is None
    assert query.find_date("改到2026-09-25") is None


def test_rejected_forced_iso_clarifies_without_calling_llm():
    calls = []

    class LLM:
        def parse_intents(self, *args):
            calls.append(args)
            return None

    p = query.understand("改到下个月初", ctx(
        selected_order_id=f"ORD{D}001", forced_date="2026-09-26"), llm=LLM())

    assert calls == []
    assert p.sub_queries[0].target_date is None
    assert p.clarify["field"] == "target_date"


def test_weekday_clarification_is_normalized_before_tool_schema():
    S.set_now(datetime(2026, 10, 1, 10, 0))  # 星期四
    p = query.understand("改到下个月初", ctx(
        selected_order_id=f"ORD{D}001", forced_date="星期四"))
    assert p.sub_queries[0].target_date == "2026-10-08"


def test_multi_intent_split_and_dates():
    p = query.understand("帮我改到大后天，顺便看看退票多少钱", ctx(selected_order_id=f"ORD{D}001"))
    assert [s.intent for s in p.sub_queries] == ["CHANGE", "REFUND"]
    assert p.sub_queries[0].target_date == "2026-09-29"
    assert p.order_id == f"ORD{D}001" and p.airline == "MU" and p.fare_product == "Y_DISCOUNT"
    assert p.clarify is None and p.confidence >= 0.85


def test_return_leg_coreference():
    p = query.understand("回程那张能退吗", ctx(order_stack=[f"ORD{D}001"]))
    assert p.order_id == f"ORD{D}002"


def test_pronoun_uses_stack_top():
    p = query.understand("它退票要多少钱", ctx(order_stack=[f"ORD{D}003", f"ORD{D}001"]))
    assert p.order_id == f"ORD{D}003"


def test_ambiguous_order_asks_user():
    p = query.understand("我要退票", ctx())
    assert p.clarify["field"] == "order_id"
    assert len(p.clarify["options"]) >= 2
    assert p.confidence < 0.85


def test_change_without_date_asks_date():
    p = query.understand("我想改签", ctx(selected_order_id=f"ORD{D}001"))
    assert p.clarify["field"] == "target_date"
    assert p.clarify["options"][0]["value"] == "2026-09-27"


def test_unparseable_date_kept_raw():
    p = query.understand("改到下个月初", ctx(selected_order_id=f"ORD{D}001"))
    assert p.sub_queries[0].target_date == "下个月初" and p.clarify is None


def test_ellipsis_inherits_last_intent():
    p = query.understand("那大后天呢", ctx(selected_order_id=f"ORD{D}001", last_intent="CHANGE"))
    assert p.sub_queries[0].intent == "CHANGE" and p.sub_queries[0].target_date == "2026-09-29"


def test_policy_without_order_uses_synonyms():
    p = query.understand("东方云航特价票能退吗", ctx(user_id="u_wang_nobody"))
    assert p.sub_queries[0].intent == "POLICY"
    assert p.airline == "MU" and p.fare_product == "SPECIAL" and p.scenario == "VOLUNTARY_REFUND"


def test_scenario_from_flight_status():
    cancelled = next(o for o in data.list_orders("u_wang")
                     if data.get_flight(o["flight_no"], o["date"])["status"] == "cancelled")
    p = query.understand("航班取消了怎么办，我要退票", ctx(user_id="u_wang", selected_order_id=cancelled["order_id"]))
    assert p.scenario == "CANCEL"


def test_clarified_values_override():
    p = query.understand("改到下个月初", ctx(selected_order_id=f"ORD{D}001", forced_date="2026-10-02"))
    assert p.sub_queries[0].target_date == "2026-10-02"
    p = query.understand("嗯", ctx(selected_order_id=f"ORD{D}001", forced_intent="REFUND"))
    assert p.sub_queries[0].intent == "REFUND" and p.clarify is None


@pytest.mark.parametrize("raw,expected", [
    ("POLICY", "POLICY"),
    (" policy ", "POLICY"),
    ("政策咨询", "POLICY"),
    ("了解规则。请只说明当前客票的退票规则，不要生成报价，也不要办理。", "POLICY"),
    ("我想退票。", "REFUND"),
    ("我要改签。", "CHANGE"),
    ("查询航班状态。", "STATUS"),
    ("随便吧，你看着办。", None),
    ("退票和改签", None),
    ({"intent": "POLICY"}, None),
])
def test_normalize_intent_answer(raw, expected):
    assert query.normalize_intent_answer(raw) == expected


def test_valid_forced_intent_overrides_provider_subqueries():
    answer = "了解规则。请只说明当前客票的退票规则，不要生成报价，也不要办理。"

    class LLM:
        def parse_intents(self, *args):
            return [SubQuery(intent="REFUND", text="我要退票")]

    p = query.understand("我要退票", ctx(
        selected_order_id=f"ORD{D}001", forced_intent=answer), llm=LLM())

    assert p.intents == ["POLICY"]
    assert p.sub_queries[0].text == answer


def test_step_back_and_hyde_text():
    p = query.understand("改到大后天", ctx(selected_order_id=f"ORD{D}001"))
    assert query.step_back_query(p, p.sub_queries[0]) == "经济舱自愿改签规则"
    assert "改期" in query.hyde_text(p, p.sub_queries[0])


# ---------- review fixes ----------
@pytest.mark.parametrize("text,expected", [
    ("31号", "2026-10-31"),          # 9 月只有 30 天，顺延到 10-31
    ("2月30日", None), ("13月1号", None), ("0号", None), ("32号", None),
    ("2026-13-45", None), ("2026-02-30", None),
    ("2月29日", "2028-02-29"),       # 下一个闰年
    ("下下周一", "2026-10-05"),
])
def test_resolve_date_never_raises(text, expected):
    assert query.resolve_date(text) == expected


def test_week_semantics_on_a_sunday():
    S.set_now(datetime(2026, 9, 27, 10, 0))     # 周日
    assert query.resolve_date("下周一") == "2026-09-28"
    assert query.resolve_date("周一") == "2026-09-28"
    assert query.resolve_date("下周日") == "2026-10-04"
    assert query.resolve_date("下下周一") == "2026-10-05"


def test_invalid_calendar_date_keeps_raw_phrase():
    p = query.understand("改到2月30日", ctx(selected_order_id=f"ORD{D}001"))
    assert p.sub_queries[0].target_date == "2月30日" and p.clarify is None


def test_next_next_week_not_read_as_next_week():
    assert query.find_date("改到下下周三") == "2026-10-07"


def test_keyword_scenario_does_not_override_known_flight_status():
    p = query.understand("我不想去了，行程取消了，帮我退票", ctx(selected_order_id=f"ORD{D}001"))
    assert p.order_id == f"ORD{D}001" and p.scenario is None


def test_keyword_scenario_still_used_without_order():
    p = query.understand("航班取消了怎么办", ctx(user_id="u_wang_nobody"))
    assert p.scenario == "CANCEL"


@pytest.mark.parametrize("text,intents", [
    ("可以退吗", ["REFUND"]), ("这张怎么退", ["REFUND"]), ("帮我退一下", ["REFUND"]), ("帮我退钱", ["REFUND"]),
    ("推迟一天", ["CHANGE"]), ("能换一天吗", ["CHANGE"]), ("改日期", ["CHANGE"]), ("换个日子", ["CHANGE"]),
    ("改天再飞", ["CHANGE"]), ("变更一下行程", ["CHANGE"]), ("我想提前到明天", ["CHANGE"]),
    ("什么情况下可以免费退票", ["REFUND"]),
    ("我想提前到机场，有什么规定", ["POLICY"]),
    ("这班还飞吗", ["STATUS"]), ("这票现在啥情况", ["STATUS"]), ("航班状态怎么样", ["STATUS"]),
])
def test_intent_patterns(text, intents):
    assert query.detect_intents(text) == intents


def test_guessed_intent_triggers_clarify():
    p = query.understand("嗯", ctx())
    assert p.confidence == 0.5 and p.clarify["field"] == "intent"


def test_order_holder_with_product_words_keeps_change_intent():
    p = query.understand("我的打折票要改到后天", ctx())
    assert [s.intent for s in p.sub_queries] == ["CHANGE"]
    assert p.sub_queries[0].target_date == "2026-09-28"
    assert p.clarify["field"] == "order_id"


def test_policy_question_without_order_but_with_orders_stays_policy():
    p = query.understand("特价票的退改规则是什么", ctx())
    assert [s.intent for s in p.sub_queries] == ["POLICY"] and p.fare_product == "SPECIAL"


@pytest.mark.parametrize("uid", ["u_zhang", "u_wang_nobody"])
def test_airline_code_next_to_cjk(uid):
    p = query.understand("坐MU的特价票能退吗", ctx(user_id=uid))
    assert p.airline == "MU"


def test_flight_number_search_tries_every_match():
    assert query.resolve_order("我订错了XX1234，其实是CA5102，能退吗", ctx(user_id="u_wang")) == f"ORD{D}012"


def test_route_regex_escapes_city_names(monkeypatch):
    real = data.get_flight

    def fake(no, date):
        f = real(no, date)
        return {**f, "dest_city": "北京("} if f and no == "MU5101" else f
    monkeypatch.setattr(data, "get_flight", fake)
    assert query.resolve_order("去北京(", ctx()) == f"ORD{D}001"


def test_return_leg_ignores_non_issued_orders():
    data.update_order(f"ORD{D}002", status="REFUNDED")
    p = query.understand("回程那张能退吗", ctx(order_stack=[f"ORD{D}001"]))
    assert p.order_id != f"ORD{D}002"


def test_order_clarify_lists_all_issued_orders_with_departed_label():
    p = query.understand("我要退票", ctx())
    opts = {o["value"]: o["label"] for o in p.clarify["options"]}
    assert set(opts) == {o["order_id"] for o in data.list_orders("u_zhang")}
    assert "（已起飞）" in opts[f"ORD{D}010"]
    assert all("（已起飞）" not in v for k, v in opts.items() if k != f"ORD{D}010")


def test_order_label_tolerates_missing_flight():
    label = query.order_label({"flight_no": "XX9999", "date": "2026-09-30", "fare_product": "Y"})
    assert "XX9999" in label


@pytest.mark.parametrize("text,intents", [
    ("航班取消了，帮我退票", ["REFUND"]),
    ("航班取消了怎么办，我要退票", ["REFUND"]),
    ("航班延误了能退票吗", ["REFUND"]),
    ("航班取消了，另外帮我退票", ["REFUND"]),
    ("这个航班现在什么情况", ["STATUS"]),
    ("航班延误了吗", ["STATUS"]),
    ("帮我看下这票现在啥情况，能改到后天吗", ["STATUS", "CHANGE"]),
    ("明天的航班延误了吗，另外帮我改签", ["STATUS", "CHANGE"]),
])
def test_status_intent_only_for_status_questions(text, intents):
    p = query.understand(text, ctx(user_id="u_wang", selected_order_id=f"ORD{D}007"))
    assert [s.intent for s in p.sub_queries] == intents


def test_unrelated_question_does_not_inherit_intent():
    p = query.understand("宠物能带上飞机吗", ctx(selected_order_id=f"ORD{D}001", last_intent="REFUND"))
    assert p.sub_queries[0].intent == "POLICY"
    assert p.clarify is not None and p.clarify["field"] == "intent"


def test_provider_cannot_downgrade_explicit_change_request_to_policy():
    """模型把「帮我改签到后天」理解成政策咨询时，仍必须保留办理意图。"""
    class LLM:
        def parse_intents(self, *args):
            return [SubQuery(intent="POLICY", text="改签规则")]

    p = query.understand("帮我改签到后天，并说明差价", ctx(selected_order_id=f"ORD{D}001"), llm=LLM())

    assert p.intents == ["CHANGE"]
    assert p.sub_queries[0].target_date is not None


def test_provider_may_supply_the_target_date_for_local_change_intent():
    class LLM:
        def parse_intents(self, *args):
            return [SubQuery(intent="CHANGE", text="改签", target_date="2026-10-03")]

    p = query.understand("改一下行程", ctx(selected_order_id=f"ORD{D}001"), llm=LLM())

    assert p.intents == ["CHANGE"]
    assert p.sub_queries[0].target_date == "2026-10-03"
