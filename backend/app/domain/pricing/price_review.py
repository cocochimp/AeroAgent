"""Post-confirmation price protection rules.

Amounts use the existing fare engine's integer CNY unit. Cross multiplication
keeps the 1% boundary exact and avoids floating-point rounding.
"""
from dataclasses import dataclass
from enum import StrEnum


class PriceReviewStatus(StrEnum):
    PROCEED_AT_CONFIRMED = "PROCEED_AT_CONFIRMED"
    REQUOTE_REQUIRED = "REQUOTE_REQUIRED"
    INVALID_AMOUNT = "INVALID_AMOUNT"


@dataclass(frozen=True, slots=True)
class PriceReview:
    status: PriceReviewStatus
    confirmed_amount: int
    current_amount: int
    platform_variance: int
    reason: str


def review_confirmed_quote(confirmed_amount: int, current_amount: int) -> PriceReview:
    """Decide whether a previously confirmed quote can still be fulfilled.

    Price decreases and increases no greater than 1% proceed at the amount the
    customer confirmed. The signed variance is posted to the platform account.
    An increase above 1% requires a new quote and a fresh confirmation.
    """
    if confirmed_amount < 0 or current_amount < 0:
        return PriceReview(
            PriceReviewStatus.INVALID_AMOUNT,
            confirmed_amount,
            current_amount,
            0,
            "金额不能为负数",
        )

    if current_amount <= confirmed_amount:
        return PriceReview(
            PriceReviewStatus.PROCEED_AT_CONFIRMED,
            confirmed_amount,
            current_amount,
            current_amount - confirmed_amount,
            "当前价格不高于已确认价格，按已确认价格办理",
        )

    if current_amount * 100 <= confirmed_amount * 101:
        return PriceReview(
            PriceReviewStatus.PROCEED_AT_CONFIRMED,
            confirmed_amount,
            current_amount,
            current_amount - confirmed_amount,
            "价格涨幅不超过 1%，差额由平台承担",
        )

    return PriceReview(
        PriceReviewStatus.REQUOTE_REQUIRED,
        confirmed_amount,
        current_amount,
        0,
        "价格涨幅超过 1%，需要重新报价并再次确认",
    )


def refund_decrease_requires_confirmation(confirmed_refund: int, current_refund: int) -> bool:
    """Never silently reduce a previously confirmed refund amount."""
    return confirmed_refund < 0 or current_refund < 0 or current_refund < confirmed_refund
