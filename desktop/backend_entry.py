"""PyInstaller 后端入口。"""
import argparse
import os
import sys
from pathlib import Path

import uvicorn

from app import evaluation
from app.api.main import app


def _configure_user_data() -> None:
    """把桌面运行数据和配置指向 userData，避免写入只读打包目录。"""
    user_data = Path(os.environ.get("AEROAGENT_USER_DATA") or Path.home() / ".aeroagent")
    os.environ["AIR_VAR_DIR"] = str(user_data / "var")
    os.environ["AIR_CONFIG_PATH"] = str(user_data / "config.json")


_configure_user_data()


def main():
    """桌面 API 入口；evaluation 子命令分派到评测 CLI，其余参数启动 HTTP 服务。"""
    argv = sys.argv[1:]
    if argv and argv[0] == "evaluation":
        _configure_user_data()
        evaluation.main(argv[1:])
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(argv)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
