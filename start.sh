#!/usr/bin/env bash
# AeroAgent：启动 Docker Compose 全栈。
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "请先安装 Docker Desktop。"; exit 1; }
env_file=.env.example
[[ ! -f .env ]] || env_file=.env
exec docker compose --env-file "$env_file" -f infra/docker-compose.yml up --build "$@"
