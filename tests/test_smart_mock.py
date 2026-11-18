import copy
import importlib.util
from datetime import datetime

import pytest

from app.application import pricing, smart_mock
from app.application.agents import proposal, verification


NOW = datetime(2026, 9, 26, 10, 0)
ORDER = {
    "order_id": "ORD-SMART-001",
    "user_id": "u_zhang",
    "flight_no": "MU5101",
    "date": "2026-09-28",
    "airline": "MU",
    "cabin": "Y",
    "fare_product": "Y_DISCOUNT",
    "fare": 900,
    "tax": 50,
    "status": "ISSUED",
}
ORIGINAL_FLIGHT = {
    "flight_no": "MU5101",
    "date": "2026-09-28",
    "airline": "MU",
    "origin": "HGH",
    "dest": "PEK",
    "origin_city": "杭州",
    "dest_city": "北京",
    "dep_time": "08:00",
    "duration_min": 130,
    "status": "scheduled",
    "delay_min": 0,
    "fares": {"Y_DISCOUNT": 900, "Y": 1500, "C": 3000, "F": 4500},
}
RATES = {"change": [10, 20, 30, 40, 50], "refund": [20, 30, 40, 50, 70]}
PROPOSALS = [
    {"flight_no": "MU6001", "date": "2026-09-29", "dep_time": "09:30",
     "cabin": "Y", "fare_product": "Y_DISCOUNT", "fare": 990},
    {"flight_no": "MU6002", "date": "2026-09-30", "dep_time": "18:05",
     "cabin": "Y", "fare_product": "Y", "fare": 1200},
    {"flight_no": "MU6003", "date": "2026-10-01", "dep_time": "07:45",
     "cabin": "C", "fare_product": "C", "fare": 1800},
    {"flight_no": "MU6004", "date": "2026-10-02", "dep_time": "12:15",
     "cabin": "F", "fare_product": "F", "fare": 2400},
    {"flight_no": "MU6005", "date": "2026-10-03", "dep_time": "22:00",
     "cabin": "Y", "fare_product": "Y_DISCOUNT", "fare": 800},
]


def _proposal(index=0, **changes):
    item = {
        "airline": "MU",
        "origin": "HGH",
        "dest": "PEK",
        "status": "scheduled",
        "delay_min": 0,
        **copy.deepcopy(PROPOSALS[index]),
    }
    item.update(changes)
    return item


def _proposals(count=3):
    return [_proposal(i % len(PROPOSALS)) for i in range(count)]


def _candidates(count=3):
    return smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, _proposals(count), NOW)


def _quotes(count=3):
    return [pricing.price_change_candidate(ORDER, ORIGINAL_FLIGHT, candidate, RATES, NOW)
            for candidate in _candidates(count)]


def _options(count=3, profile=None):
    return smart_mock.generate_change_options(
        ORDER, ORIGINAL_FLIGHT, _proposals(count), RATES, NOW, profile=profile)


def test_smart_mock_module_exists():
    assert importlib.util.find_spec("app.application.smart_mock") is not None


@pytest.mark.parametrize("count", range(2, 6))
def test_generates_two_to_five_distinct_deterministic_candidates(count):
    first = _candidates(count)
    second = _candidates(count)

    assert len(first) == count
    assert first == second
    assert len({c["candidate_id"] for c in first}) == count
    assert len({(c["flight_no"], c["date"]) for c in first}) == count
    assert all(c["candidate_id"].startswith("chg_") for c in first)
    assert all(c["airline"] == ORDER["airline"] for c in first)
    assert all((c["origin"], c["dest"]) == ("HGH", "PEK") for c in first)
    assert all(c["fares"] == {c["fare_product"]: c["fare"]} for c in first)
    assert all(c["source"] == "smart_mock" and c["source_order_id"] == ORDER["order_id"]
               for c in first)


def test_candidate_id_is_stable_and_scoped_to_order_and_flight_date():
    candidate_id = smart_mock.candidate_id_for(ORDER["order_id"], "MU6001", "2026-09-29")
    assert candidate_id == smart_mock.candidate_id_for(ORDER["order_id"], "MU6001", "2026-09-29")
    assert candidate_id != smart_mock.candidate_id_for("ORD-OTHER", "MU6001", "2026-09-29")
    assert candidate_id != smart_mock.candidate_id_for(ORDER["order_id"], "MU6001", "2026-09-30")


@pytest.mark.parametrize("count", [0, 1, 6])
def test_candidate_count_outside_two_to_five_is_rejected(count):
    with pytest.raises(smart_mock.CandidateValidationError) as exc:
        _candidates(count)
    assert exc.value.code == "CANDIDATE_COUNT"


@pytest.mark.parametrize("mutation", [
    lambda p: p.pop("flight_no"),
    lambda p: p.update(unknown="not-in-schema"),
    lambda p: p.update(fare="990"),
    lambda p: p.update(cabin="P"),
    lambda p: p.update(fare_product="UNKNOWN"),
    lambda p: p.update(cabin="C", fare_product="Y"),
    lambda p: p.update(status="unknown"),
])
def test_schema_and_fare_product_violations_are_rejected(mutation):
    proposals = _proposals(2)
    mutation(proposals[0])
    with pytest.raises(smart_mock.CandidateValidationError) as exc:
        smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, proposals, NOW)
    assert exc.value.code == "SCHEMA_INVALID"


@pytest.mark.parametrize("fare", [0, -1, 100001, 1.5, True])
def test_price_bounds_and_strict_integer_prices_are_enforced(fare):
    proposals = _proposals(2)
    proposals[0]["fare"] = fare
    with pytest.raises(smart_mock.CandidateValidationError) as exc:
        smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, proposals, NOW)
    assert exc.value.code == "SCHEMA_INVALID"


@pytest.mark.parametrize("day,time", [
    ("2026-09-25", "09:30"),
    ("2026-09-26", "09:59"),
    ("2026-02-30", "09:30"),
    ("2026-09-29", "24:00"),
    ("2026-09-29", "09:30:00"),
])
def test_invalid_or_non_future_dates_and_times_are_rejected(day, time):
    proposals = _proposals(2)
    proposals[0].update(date=day, dep_time=time)
    with pytest.raises(smart_mock.CandidateValidationError):
        smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, proposals, NOW)


@pytest.mark.parametrize("changes,code", [
    ({"airline": "CA"}, "AIRLINE_MISMATCH"),
    ({"origin": "PEK"}, "ROUTE_MISMATCH"),
    ({"dest": "CAN"}, "ROUTE_MISMATCH"),
])
def test_airline_and_route_cannot_change(changes, code):
    proposals = _proposals(2)
    proposals[0].update(changes)
    with pytest.raises(smart_mock.CandidateValidationError) as exc:
        smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, proposals, NOW)
    assert exc.value.code == code


def test_same_original_flight_date_is_not_a_change_candidate():
    proposals = _proposals(2)
    proposals[0].update(flight_no=ORDER["flight_no"], date=ORDER["date"], dep_time="23:00")
    with pytest.raises(smart_mock.CandidateValidationError) as exc:
        smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, proposals, NOW)
    assert exc.value.code == "SAME_FLIGHT"


def test_duplicate_flight_date_is_rejected_even_with_another_fare_product():
    proposals = _proposals(2)
    proposals[1].update(flight_no=proposals[0]["flight_no"], date=proposals[0]["date"],
                        cabin="C", fare_product="C", fare=1800)
    with pytest.raises(smart_mock.CandidateValidationError) as exc:
        smart_mock.validate_candidates(ORDER, ORIGINAL_FLIGHT, proposals, NOW)
    assert exc.value.code == "DUPLICATE_CANDIDATE"


def test_each_candidate_is_priced_independently_from_original_rules_and_target_fare():
    quotes = _quotes(3)

    assert [q["candidate_id"] for q in quotes] == [c["candidate_id"] for c in _candidates(3)]
    assert [q["change_fee"] for q in quotes] == [270, 270, 270]
    assert [q["fare_diff"] for q in quotes] == [90, 300, 900]
    assert [q["total"] for q in quotes] == [360, 570, 1170]
    assert [q["target"]["fare_product"] for q in quotes] == ["Y_DISCOUNT", "Y", "C"]
    assert [q["target"]["cabin"] for q in quotes] == ["Y", "Y", "C"]
    assert all(q["rule_id"] == "MU-Y_DISCOUNT-CHG" for q in quotes)
    assert all(q["window"] == "h4" and q["rate_pct"] == 30 for q in quotes)

    quotes[0]["target"]["fare"] = 1
    quotes[0]["total"] = 1
    assert quotes[1]["target"]["fare"] == 1200 and quotes[1]["total"] == 570


def test_candidate_id_does_not_depend_on_profile_or_requote_amount():
    first = pricing.price_change_candidate(ORDER, ORIGINAL_FLIGHT, _candidates(2)[0], RATES, NOW)
    changed_fare = copy.deepcopy(_candidates(2)[0])
    changed_fare["fare"] = 1090
    changed_fare["fares"] = {"Y_DISCOUNT": 1090}
    second = pricing.price_change_candidate(ORDER, ORIGINAL_FLIGHT, changed_fare, RATES, NOW)

    assert first["candidate_id"] == second["candidate_id"]
    assert first["total"] == 360 and second["total"] == 460


def test_pricing_preserves_involuntary_status_and_not_issued_invariants():
    candidates = _candidates(2)
    disrupted = {**ORIGINAL_FLIGHT, "status": "delayed", "delay_min": 120}
    involuntary = pricing.price_change_candidate(ORDER, disrupted, candidates[0], RATES, NOW)
    assert involuntary["involuntary"] is True
    assert involuntary["rule_id"] == "GEN-DELAY"
    assert involuntary["change_fee"] == involuntary["fare_diff"] == involuntary["total"] == 0

    with pytest.raises(pricing.PricingError) as exc:
        pricing.price_change_candidate({**ORDER, "status": "REFUNDED"}, ORIGINAL_FLIGHT,
                                       candidates[0], RATES, NOW)
    assert exc.value.code == "ORDER_NOT_ISSUED"


def test_pricing_preserves_target_time_route_and_changeability_invariants():
    candidate = _candidates(2)[0]
    with pytest.raises(pricing.PricingError) as exc:
        pricing.price_change_candidate(ORDER, ORIGINAL_FLIGHT,
                                       {**candidate, "status": "cancelled"}, RATES, NOW)
    assert exc.value.code == "TARGET_UNAVAILABLE"

    with pytest.raises(pricing.PricingError) as exc:
        pricing.price_change_candidate(ORDER, ORIGINAL_FLIGHT,
                                       {**candidate, "origin": "PEK"}, RATES, NOW)
    assert exc.value.code == "NO_TARGET_FLIGHT"

    not_allowed = pricing.price_change_candidate(ORDER, ORIGINAL_FLIGHT, candidate,
                                                 {**RATES, "change": None}, NOW)
    assert not_allowed["allowed"] is False
    assert not_allowed["total"] == 0
    assert "不得自愿改签" in not_allowed["reason"]


def test_high_level_pipeline_does_not_recommend_forbidden_voluntary_changes():
    with pytest.raises(pricing.PricingError) as exc:
        smart_mock.generate_change_options(ORDER, ORIGINAL_FLIGHT, _proposals(2),
                                           {**RATES, "change": None}, NOW)
    assert exc.value.code == "CHANGE_NOT_ALLOWED"


def test_staged_presentation_rejects_nonbookable_quote_set():
    quotes = _quotes(2)
    blocked = {**quotes[0], "allowed": False, "change_fee": 0, "fare_diff": 0, "total": 0,
               "reason": "该票价产品不得自愿改签"}

    with pytest.raises(ValueError, match="不可办理"):
        proposal.generate_change_options([blocked, quotes[1]])


def test_profile_changes_ranking_and_reason_but_never_quotes():
    quotes = _quotes(3)
    original_quotes = copy.deepcopy(quotes)
    premium = {"tier": "黑钻", "data": {"price_sensitivity": "低", "products": {"C": 10}}}
    budget = {"tier": "普卡", "data": {"price_sensitivity": "高", "products": {}}}

    premium_options = proposal.generate_change_options(quotes, premium)
    budget_options = proposal.generate_change_options(quotes, budget)

    assert premium_options[0]["candidate_id"] == quotes[2]["candidate_id"]
    assert budget_options[0]["candidate_id"] == quotes[0]["candidate_id"]
    assert "票种偏好" in premium_options[0]["rationale"]
    assert "合计最低" in budget_options[0]["rationale"]
    assert sum(o["recommended"] for o in premium_options) == 1
    assert [o["rank"] for o in premium_options] == [1, 2, 3]
    assert quotes == original_quotes

    for options in (premium_options, budget_options):
        assert {o["candidate_id"]: o["total"] for o in options} == {
            q["candidate_id"]: q["total"] for q in original_quotes}
        assert {o["candidate_id"]: o["quote"]["change_fee"] for o in options} == {
            q["candidate_id"]: q["change_fee"] for q in original_quotes}


def test_high_level_pipeline_returns_two_to_five_factual_options():
    options = _options(5)
    assert len(options) == 5
    assert len({o["candidate_id"] for o in options}) == 5
    assert all(o["type"] == "CHANGE" and o["allowed"] for o in options)
    assert all(o["rationale"] and o["quote"]["candidate_id"] == o["candidate_id"] for o in options)
    assert all(o["total"] == o["quote"]["total"] for o in options)
    assert all(o["target"]["dep_time"] == o["quote"]["target"]["dep_time"] for o in options)


def test_model_supplied_rationale_is_discarded_and_regenerated_from_quote_facts():
    proposals = _proposals(2)
    proposals[0]["rationale"] = "金卡会员免费，赠送休息室，余票充足，虚构价格1元。"
    options = smart_mock.generate_change_options(ORDER, ORIGINAL_FLIGHT, proposals, RATES, NOW)

    assert "虚构" not in options[0]["rationale"] + options[1]["rationale"]
    assert "休息室" not in options[0]["rationale"] + options[1]["rationale"]
    assert "1元" not in options[0]["rationale"] + options[1]["rationale"]
    assert verification.check_change_options(options, quotes=_quotes(len(options)), profile=None)["passed"]


def test_generated_rationales_pass_independent_verification():
    profile = {"tier": "金卡", "data": {"price_sensitivity": "高", "products": {"Y": 8}}}
    options = _options(3, profile)
    result = verification.check_change_options(options, quotes=_quotes(len(options)), profile=profile)
    assert result["passed"] and result["confidence"] == 1.0
    assert result["quote_mismatch"] is False
    assert result["unsupported_claims"] == []


@pytest.mark.parametrize("field,value", [("type", "REFUND"), ("allowed", False)])
def test_verification_checks_option_type_and_allowed_against_quote(field, value):
    options = _options(2)
    options[0][field] = value

    result = verification.check_change_options(options, quotes=_quotes(len(options)))

    assert not result["passed"]
    assert any(field in error for error in result["errors"])


@pytest.mark.parametrize("old,new", [
    ("MU6001", "MU6999"),
    ("2026-09-29", "2026-10-09"),
    ("09:30", "10:30"),
    ("Y舱", "C舱"),
    ("Y_DISCOUNT", "SPECIAL"),
])
def test_verification_rejects_title_target_fact_mismatch(old, new):
    options = _options(2)
    assert old in options[0]["title"]
    options[0]["title"] = options[0]["title"].replace(old, new, 1)

    result = verification.check_change_options(options, quotes=_quotes(len(options)))

    assert not result["passed"]
    assert any("标题" in error for error in result["errors"])


def test_verification_accepts_reworded_title_with_correct_target_facts():
    options = _options(2)
    target = options[0]["target"]
    options[0]["title"] = (f"航班 {target['flight_no']}，{target['date']} {target['dep_time']} 出发，"
                           f"{target['cabin']}舱，票种：{target['fare_product']}")

    result = verification.check_change_options(options, quotes=_quotes(len(options)))

    assert result["passed"], result["errors"]


def test_verification_rejects_wrong_numeric_fare_in_title():
    options = _options(2)
    options[0]["title"] += f"，票面价{options[0]['target']['fare'] - 1}元"

    result = verification.check_change_options(options, quotes=_quotes(len(options)))

    assert not result["passed"]
    assert any("标题" in error for error in result["errors"])


def test_rationale_with_wrong_or_unsupported_price_is_rejected():
    options = _options(2)
    options[0]["rationale"] = "改期费999元，合计360元。"
    result = verification.check_change_options(options, quotes=_quotes(len(options)))
    assert not result["passed"] and result["quote_mismatch"]
    assert 999 in result["bad_quotes"]

    options = _options(2)
    options[0]["rationale"] = "另需支付999元。"
    result = verification.check_change_options(options, quotes=_quotes(len(options)))
    assert not result["passed"] and result["quote_mismatch"]


def test_rationale_cannot_add_membership_benefit_or_inventory_claims():
    options = _options(2)
    options[0]["rationale"] += "金卡会员免费改签，赠送休息室且余票充足。"
    result = verification.check_change_options(options, quotes=_quotes(len(options)))
    assert not result["passed"]
    assert result["unsupported_claims"] == ["金卡会员免费改签，赠送休息室且余票充足"]


def test_rationale_cannot_falsely_claim_lowest_total_or_profile_match():
    options = _options(3)
    options[1]["rationale"] += "本候选合计最低。"
    result = verification.check_change_options(options, quotes=_quotes(len(options)))
    assert not result["passed"]
    assert result["unsupported_claims"] == ["本候选合计最低"]

    profile = {"data": {"price_sensitivity": "低", "products": {"C": 10}}}
    options = _options(3, profile)
    non_c = next(o for o in options if o["target"]["fare_product"] != "C")
    non_c["rationale"] += "符合画像中的 C 票种偏好。"
    result = verification.check_change_options(options, quotes=_quotes(len(options)), profile=profile)
    assert not result["passed"]
    assert result["unsupported_claims"] == ["符合画像中的 C 票种偏好"]


def test_canonical_drift_is_not_misreported_as_an_unsupported_claim():
    options = _options(2)
    options[0]["rationale"] = "行程与费用已按报价核算。"

    result = verification.check_change_options(options, quotes=_quotes(len(options)))

    assert not result["passed"]
    assert result["unsupported_claims"] == []
    assert result["canonical_mismatches"] == [options[0]["candidate_id"]]


def test_true_lowest_claim_is_supported_even_when_canonical_text_differs():
    options = _options(2)
    options[0]["rationale"] = "本候选合计最低。"

    result = verification.check_change_options(options, quotes=_quotes(len(options)))

    assert not result["passed"]
    assert result["unsupported_claims"] == []
    assert result["canonical_mismatches"] == [options[0]["candidate_id"]]


def test_option_amount_candidate_identity_and_count_are_verified():
    options = _options(2)
    options[0]["total"] += 1
    result = verification.check_change_options(options, quotes=_quotes(len(options)))
    assert not result["passed"] and result["quote_mismatch"]

    options = _options(2)
    options[0]["fee_items"][0]["amount"] += 1
    assert not verification.check_change_options(options, quotes=_quotes(len(options)))["passed"]

    options = _options(2)
    options[1]["candidate_id"] = options[0]["candidate_id"]
    result = verification.check_change_options(options, quotes=_quotes(len(options)))
    assert not result["passed"] and any("candidate_id" in e for e in result["errors"])

    assert not verification.check_change_options(_options(2)[:1], quotes=_quotes(2))["passed"]


def test_public_verification_requires_independently_retained_quotes():
    trusted = _quotes(2)
    tampered = copy.deepcopy(trusted)
    tampered[0].update(change_fee=0, fare_diff=0, total=0)
    options = proposal.generate_change_options(tampered)

    with pytest.raises(TypeError):
        verification.check_change_options(options)


def test_trusted_quote_path_accepts_valid_options_and_rejects_self_consistent_tampering():
    trusted = _quotes(2)
    valid_options = proposal.generate_change_options(trusted)
    assert verification.check_change_options(valid_options, quotes=trusted)["passed"]

    tampered = copy.deepcopy(trusted)
    tampered[0].update(change_fee=0, fare_diff=0, total=0)
    tampered_options = proposal.generate_change_options(tampered)
    result = verification.check_change_options(tampered_options, quotes=trusted)

    assert not result["passed"]
    assert result["quote_mismatch"]
    assert any("内嵌报价" in error or "合计" in error for error in result["errors"])
