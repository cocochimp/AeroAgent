"""航司适配器工厂：mock / http / cassette 只在这里切换。"""
from pathlib import Path

from app import config
from app.adapters.outbound.airline.cassette import CassetteAirlineGateway
from app.adapters.outbound.airline.http import HttpAirlineGateway
from app.adapters.outbound.airline.mock import MockAirlineGateway
from app.adapters.outbound.airline.scenarios import current_scenario
from app.application.ports.services import AirlineGateway


def create_airline_gateway() -> AirlineGateway:
    """按运行配置创建航司网关；默认 mock，真实接口只改配置。"""
    cfg = config.get()["airline"]
    mode = cfg.get("mode", "mock")
    if mode == "http":
        return HttpAirlineGateway(base_url=cfg.get("base_url", ""),
                                  auth_header=cfg.get("auth_header", ""),
                                  timeout=float(cfg.get("timeout", 5)))
    if mode == "cassette":
        directory = Path(cfg.get("cassette_dir", "demo_data/cassettes"))
        return CassetteAirlineGateway(directory / "airline_cassettes.json")
    return MockAirlineGateway(scenario=current_scenario())
