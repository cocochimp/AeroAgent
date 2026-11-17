"""应用层拥有的出站适配器接口，隔离业务用例与具体基础设施。"""
from typing import Protocol


class CaseRepository(Protocol):
    """定义案件读写端口；应用层不依赖具体数据库模型。"""

    async def get(self, case_id: str) -> dict | None:
        """按标识读取案件；不存在时返回空值。"""
        ...

    async def save(self, case: dict) -> None:
        """保存案件快照；事务边界由工作单元控制。"""
        ...


class QuoteRepository(Protocol):
    """定义报价读写端口；隔离报价快照与持久化实现。"""

    async def get(self, quote_id: str) -> dict | None:
        """按标识读取报价；不存在时返回空值。"""
        ...

    async def save(self, quote: dict) -> None:
        """保存报价及其确认快照；事务边界由工作单元控制。"""
        ...


class OperationRepository(Protocol):
    """定义办理记录端口；幂等键查询是重复请求防护的一部分。"""

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        """按幂等键查找既有办理记录；用于重放请求而不是重复出票。"""
        ...

    async def create(self, operation: dict) -> dict:
        """创建待办理记录；实现需保证幂等键唯一。"""
        ...

    async def update(self, operation: dict) -> None:
        """更新办理状态和结果；最终状态由履约流程统一写入。"""
        ...


class UnitOfWork(Protocol):
    """聚合仓储并定义事务边界；用例通过它保证业务写入原子性。"""

    async def __aenter__(self) -> "UnitOfWork":
        """开启事务并返回聚合仓储入口。"""
        ...

    async def __aexit__(self, exc_type, exc, tb) -> bool | None:
        """退出事务上下文；异常时由实现完成回滚。"""
        ...

    @property
    def cases(self) -> CaseRepository:
        """提供当前事务内的案件仓储。"""
        ...

    @property
    def quotes(self) -> QuoteRepository:
        """提供当前事务内的报价仓储。"""
        ...

    @property
    def operations(self) -> OperationRepository:
        """提供当前事务内的办理记录仓储。"""
        ...

    async def commit(self) -> None:
        """提交当前工作单元；失败时由上下文管理器回滚。"""
        ...


class UnitOfWorkFactory(Protocol):
    """定义工作单元工厂；让应用服务按需开启独立事务。"""

    def __call__(self) -> UnitOfWork:
        """创建新的工作单元；每次调用应对应独立事务。"""
        ...


class AirlineGateway(Protocol):
    """定义航司写侧网关；提交与幂等查询共同支撑结果核对。"""

    async def submit(self, command: dict) -> dict:
        """向航司提交退改命令；实现必须透传幂等键并区分拒绝与超时。"""
        ...

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        """按幂等键查询航司办理结果；用于超时后的对账。"""
        ...


class DecisionEngine(Protocol):
    """定义 ReAct 决策端口；离线规则和在线模型可互换。"""

    mode: str

    def decide(self, state: dict, messages: list[dict]) -> dict:
        """根据图状态和消息选择下一动作；输出仍需经过工具 Schema 校验。"""
        ...


class EventPublisher(Protocol):
    """定义领域事件发布端口；业务用例不依赖消息流实现。"""

    async def publish(self, topic: str, event: dict) -> None:
        """发布指定主题事件；可靠投递策略由适配器实现。"""
        ...


class TraceSink(Protocol):
    """定义链路记录端口；核心业务不依赖具体遥测后端。"""

    async def record(self, name: str, attributes: dict) -> None:
        """记录一次命名链路和属性；实现不得改变业务结果。"""
        ...
