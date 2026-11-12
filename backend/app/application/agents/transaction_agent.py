"""Write-side Agent facade. Execution accepts only a persisted confirmed operation."""
from dataclasses import dataclass
from opentelemetry import trace

from backend.app.application.fulfillment import fulfill_operation

_tracer = trace.get_tracer("air-ticket.agent.transaction")


@dataclass(frozen=True, slots=True)
class ConfirmedQuoteCommand:
    operation_id: str


class TicketTransactionAgent:
    async def execute(self, command: ConfirmedQuoteCommand) -> dict:
        if not command.operation_id:
            raise ValueError("交易命令必须绑定已确认报价生成的 operation_id")
        with _tracer.start_as_current_span("agent.transaction.execute") as span:
            span.set_attribute("servicing.operation_id", command.operation_id)
            return await fulfill_operation(command.operation_id)
