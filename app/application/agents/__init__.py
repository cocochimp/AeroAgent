"""明确三个机票客服 Agent 的职责边界。

采用延迟导出，避免启动时加载单个 Agent 又把交易履约反向载入案件服务。
"""
from importlib import import_module

_EXPORTS = {
    "MainServiceAgent": ".main_agent",
    "ServicingAdvisorAgent": ".solution_agent",
    "TicketTransactionAgent": ".transaction_agent",
}
__all__ = list(_EXPORTS)


def __getattr__(name: str):
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value
