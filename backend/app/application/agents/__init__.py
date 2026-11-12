"""Explicit role boundaries for the three ticket servicing Agents.

Exports are lazy so importing one Agent does not eagerly load transaction
fulfillment back into the case service during application startup.
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
