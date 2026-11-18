"""Pure SmartMock change-candidate validation and quote orchestration.

Provider output is an untrusted proposal, never a quote. This module validates the
complete batch, derives stable identities, and delegates every amount to pricing.
Persistence and provider calls intentionally live outside this pure boundary.
"""
from collections.abc import Mapping, Sequence
from datetime import datetime
import hashlib
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.application import seed
from app.application.pricing import MAX_FARE, MIN_FARE, PricingError, price_change_candidate


_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_TIME = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")


class CandidateValidationError(ValueError):
    """Reject an untrusted candidate batch with a stable machine-readable code."""

    def __init__(self, code: str, message: str, details: list[dict] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or []


class CandidateProposal(BaseModel):
    """Strict provider schema; rationale is accepted only to be discarded."""

    model_config = ConfigDict(strict=True, extra="forbid")

    flight_no: str = Field(pattern=r"^[A-Z0-9]{3,16}$")
    date: str
    dep_time: str
    airline: str = Field(pattern=r"^[A-Z0-9]{2,4}$")
    origin: str = Field(pattern=r"^[A-Z]{3}$")
    dest: str = Field(pattern=r"^[A-Z]{3}$")
    origin_city: str | None = Field(default=None, max_length=80)
    dest_city: str | None = Field(default=None, max_length=80)
    duration_min: int | None = Field(default=None, ge=1, le=1440)
    status: Literal["scheduled", "delayed", "cancelled"] = "scheduled"
    delay_min: int = Field(default=0, ge=0, le=1440)
    cabin: str
    fare_product: str
    fare: int = Field(ge=MIN_FARE, le=MAX_FARE)
    rationale: str | None = Field(default=None, max_length=500)


def candidate_id_for(order_id: str, flight_no: str, flight_date: str) -> str:
    """Identify the same order/flight/date snapshot across requotes, never by price."""
    canonical = json.dumps({"order_id": order_id, "flight_no": flight_no, "date": flight_date},
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"chg_{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:24]}"


def _departure(proposal: CandidateProposal, index: int) -> datetime:
    if not _DATE.fullmatch(proposal.date) or not _TIME.fullmatch(proposal.dep_time):
        raise CandidateValidationError("DATETIME_INVALID", f"候选 {index + 1} 的日期或时间格式无效")
    try:
        return datetime.fromisoformat(f"{proposal.date}T{proposal.dep_time}")
    except ValueError as exc:
        raise CandidateValidationError("DATETIME_INVALID", f"候选 {index + 1} 的日期或时间无效") from exc


def _schema_error(index: int, exc: ValidationError) -> CandidateValidationError:
    details = [{"loc": list(error["loc"]), "message": error["msg"], "type": error["type"]}
               for error in exc.errors()]
    return CandidateValidationError("SCHEMA_INVALID", f"候选 {index + 1} 结构校验失败",
                                    [{"index": index, "errors": details}])


def validate_candidates(order: Mapping, original_flight: Mapping,
                        proposals: Sequence[Mapping], now: datetime) -> list[dict]:
    """Validate all proposals atomically and return independent flight snapshots.

    Exactly 2–5 unique flight/date candidates are required. Any invalid item rejects
    the batch rather than silently presenting an incomplete or unvalidated set.
    """
    if isinstance(proposals, (str, bytes)) or not isinstance(proposals, Sequence) or not 2 <= len(proposals) <= 5:
        raise CandidateValidationError("CANDIDATE_COUNT", "SmartMock 改签候选必须为 2–5 个")

    validated, seen = [], set()
    for index, raw in enumerate(proposals):
        try:
            item = CandidateProposal.model_validate(raw)
        except ValidationError as exc:
            raise _schema_error(index, exc) from exc
        if item.fare_product not in seed.PRODUCTS or seed.PRODUCTS[item.fare_product][0] != item.cabin:
            raise CandidateValidationError("SCHEMA_INVALID", f"候选 {index + 1} 的舱位与票价产品不匹配")
        if item.airline != order.get("airline") or item.airline != original_flight.get("airline"):
            raise CandidateValidationError("AIRLINE_MISMATCH", f"候选 {index + 1} 不得更换航司")
        if (item.origin, item.dest) != (original_flight.get("origin"), original_flight.get("dest")):
            raise CandidateValidationError("ROUTE_MISMATCH", f"候选 {index + 1} 不得更换航线")

        departure = _departure(item, index)
        if departure <= now:
            raise CandidateValidationError("DEPARTURE_NOT_FUTURE", f"候选 {index + 1} 必须在未来起飞")
        if item.status == "cancelled":
            raise CandidateValidationError("TARGET_UNAVAILABLE", f"候选 {index + 1} 已取消")
        if item.flight_no == order.get("flight_no") and item.date == order.get("date"):
            raise CandidateValidationError("SAME_FLIGHT", f"候选 {index + 1} 与原航班相同")
        flight_date_key = (item.flight_no, item.date)
        if flight_date_key in seen:
            raise CandidateValidationError("DUPLICATE_CANDIDATE",
                                           f"候选 {index + 1} 的航班日期重复：{item.flight_no} {item.date}")
        seen.add(flight_date_key)

        snapshot = item.model_dump(exclude={"rationale"})
        snapshot["origin_city"] = item.origin_city or original_flight.get("origin_city", "")
        snapshot["dest_city"] = item.dest_city or original_flight.get("dest_city", "")
        snapshot["duration_min"] = item.duration_min or original_flight.get("duration_min", 0)
        snapshot["fares"] = {item.fare_product: item.fare}
        snapshot.update(candidate_id=candidate_id_for(order["order_id"], item.flight_no, item.date),
                        source="smart_mock", source_order_id=order["order_id"])
        validated.append(snapshot)
    return validated


def generate_change_options(order: Mapping, original_flight: Mapping, proposals: Sequence[Mapping],
                            rates: Mapping, now: datetime, profile: Mapping | None = None) -> list[dict]:
    """Validate, independently quote, then rank candidates without mutating inputs."""
    candidates = validate_candidates(order, original_flight, proposals, now)
    quotes = [price_change_candidate(order, original_flight, candidate, rates, now)
              for candidate in candidates]
    if any(not quote["allowed"] for quote in quotes):
        reason = next(quote["reason"] for quote in quotes if not quote["allowed"])
        raise PricingError("CHANGE_NOT_ALLOWED", reason)
    from app.application.agents.proposal import generate_change_options as present_options
    return present_options(quotes, profile)
