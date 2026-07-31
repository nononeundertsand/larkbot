#!/usr/bin/env bash
# 一键启动飞书机器人自动回复
set -euo pipefail
cd "$(dirname "$0")"

# 注意：.env 不再由 shell source（shell 会吞掉值里的双引号，破坏 LLM_MODELS 等 JSON 配置）。
# 改由 bot.mjs 启动时通过 src/env.mjs 自行解析，能正确处理带引号/JSON 的值。
if [ ! -f .env ]; then
  echo "[start] 未找到 .env，将以 mock 回声模式运行（复制 .env.example 为 .env 可接入大模型）"
fi

# 前置检查：lark-cli 是否可用（仅取 LARK_CLI_BIN 一个变量，避免 source 整个 .env）
# 注意：grep 匹配不到会返回非零，配合 set -e 会误杀脚本，故用 || true 兜底。
LARK_BIN="${LARK_CLI_BIN:-}"
if [ -z "$LARK_BIN" ] && [ -f .env ]; then
  LARK_BIN="$(grep -E '^LARK_CLI_BIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' " || true)"
fi
LARK_BIN="${LARK_BIN:-lark-cli}"
if ! command -v "$LARK_BIN" >/dev/null 2>&1; then
  echo "[start] 错误：找不到 $LARK_BIN，请先安装并 lark-cli auth login" >&2
  exit 1
fi

exec node src/bot.mjs
