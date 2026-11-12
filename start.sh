#!/usr/bin/env bash
# 机票退改签 Agent：默认启动 Docker Compose 全栈；传 --cli 使用旧版学习 CLI。
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${1:-}" == "--cli" ]]; then
  shift
  command -v uv >/dev/null || { echo "请先安装 uv：https://docs.astral.sh/uv/"; exit 1; }
  exec uv run python -m air_agent "$@"
fi
command -v docker >/dev/null || { echo "请先安装 Docker Desktop。"; exit 1; }
env_file=.env.example
[[ ! -f .env ]] || env_file=.env
exec docker compose --env-file "$env_file" -f infra/docker-compose.yml up --build "$@"
