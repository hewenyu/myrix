#!/usr/bin/env bash
# Myrix 一键初始化：子模块 → 依赖 → 类型检查 → 测试
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] 初始化 DSH 子模块（vendor/deepseek-harness）…"
git submodule update --init --recursive vendor/deepseek-harness

echo "[2/4] 安装工作区依赖…"
pnpm install

echo "[3/4] 类型检查…"
pnpm typecheck

echo "[4/4] 单元测试…"
pnpm test

cat <<'EOF'

初始化完成。下一步：
  启动控制面与管理后台：pnpm dev      → http://127.0.0.1:8787/
  渲染某个主体的 DSH profile：
      pnpm render:profile u_1001 --out "$DSH_HOME/profiles/enterprise"
  查看判定演示：          pnpm demo:decide
EOF
