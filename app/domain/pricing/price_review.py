"""确认后的价格保护规则。

金额沿用运价引擎的整数人民币单位，交叉相乘保证 1% 边界精确且不使用浮点舍入。
"""
from dataclasses import dataclass
from enum import StrEnum


class PriceReviewStatus(StrEnum):
    """枚举价格复核结论；明确区分继续办理、重新报价和非法金额。"""
    PROCEED_AT_CONFIRMED = "PROCEED_AT_CONFIRMED"
    REQUOTE_REQUIRED = "REQUOTE_REQUIRED"
    INVALID_AMOUNT = "INVALID_AMOUNT"


@dataclass(frozen=True, slots=True)
class PriceReview:
    """保存价格复核结果和平台差额；有符号差额用于后续分账。"""
    status: PriceReviewStatus
    confirmed_amount: int
    current_amount: int
    platform_variance: int
    reason: str


def review_confirmed_quote(confirmed_amount: int, current_amount: int) -> PriceReview:
    """判断已确认报价能否继续履约，区分可沿用、需重报和非法金额。"""
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

    # 交叉相乘判断 1% 上限，整数金额不做浮点除法。
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
    """判断退款减少是否需重新确认，防止未经同意降低已确认金额。"""
    return confirmed_refund < 0 or current_refund < 0 or current_refund < confirmed_refund
