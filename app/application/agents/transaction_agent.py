"""写侧交易 Agent 门面，只接受已持久化的确认操作。"""
from dataclasses import dataclass
from opentelemetry import trace

from app.application.fulfillment import fulfill_operation
from app.application.ports.services import AirlineGateway

_tracer = trace.get_tracer("air-ticket.agent.transaction")


@dataclass(frozen=True, slots=True)
class ConfirmedQuoteCommand:
    """封装已确认报价的操作标识；交易入口不直接接收金额或航班等可篡改字段。"""
    operation_id: str


class TicketTransactionAgent:
    """执行持久化后的已确认操作；通过履约服务完成幂等和价格复核。"""
    def __init__(self, airline: AirlineGateway | None = None):
        if airline is None:
            from app.adapters.outbound.airline.mock import MockAirlineGateway
            airline = MockAirlineGateway()
        self._airline = airline

    async def execute(self, command: ConfirmedQuoteCommand) -> dict:
        """办理已确认报价对应的退改操作；空操作标识在进入履约前直接拒绝。"""
        if not command.operation_id:
            raise ValueError("交易命令必须绑定已确认报价生成的 operation_id")
        with _tracer.start_as_current_span("agent.transaction.execute") as span:
            span.set_attribute("servicing.operation_id", command.operation_id)
            return await fulfill_operation(command.operation_id, self._airline)
