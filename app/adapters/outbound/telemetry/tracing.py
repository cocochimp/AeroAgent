"""可选 OTLP 链路配置；不记录请求体、凭证或客户数据。"""
import os

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter


def configure_tracing(service_name: str | None = None) -> None:
    """按环境变量启用 OTLP 链路导出；未配置端点时保持无后端且不记录敏感请求数据。"""
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        return
    provider = TracerProvider(resource=Resource.create({
        "service.name": service_name or os.getenv("OTEL_SERVICE_NAME", "aeroagent-api")
    }))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
