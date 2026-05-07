#!/usr/bin/env bash
# start.sh — launch the bot from this repo with all state contained in ./runtime/.
#
# Boots scripts/gateway.ts (the supervisor), which in turn spawns the pi
# binary in --mode rpc, health-pings it, restarts on crash/hang, and runs
# any scheduled tasks defined in runtime/cron.json. To bypass the gateway
# and run pi directly (e.g. for debugging), pass --no-gateway.
#
# Self-contained env: every path-bearing env var points inside ./runtime/, so
# the bot tree is `cp -r`-able / `tar`-able to another machine and Just Works.
#   PI_CODING_AGENT_DIR  -> runtime/agent          (sessions, auth, models, ext cache)
#   PI_TELEGRAM_CONFIG   -> runtime/agent/telegram.json
#   PI_MEMORY_DIR        -> runtime/agent/memory   (MEMORY.md, scratchpad, daily logs)
#   QMD_CONFIG_DIR       -> runtime/qmd-config     (qmd collection registry)
#   XDG_CACHE_HOME       -> runtime/cache          (qmd index.sqlite + GGUF models, bun cache)
#   PATH (prefix)        -> runtime/bun/bin        (bundled bun + qmd)
#
# The binary name is whatever was chosen at ./setup.sh time and stored in
# runtime/agent/.bot-name (defaults to "pi"). Invoked via runtime/bin/<NAME>
# so `ps aux` shows the bot name, not generic "pi", on machines running
# multiple parallel installs.
#
# Usage:
#   ./start.sh                # foreground (gateway supervises pi)
#   ./start.sh --tmux         # detached tmux, session name = bot name
#   ./start.sh --tmux <name>  # detached tmux, session name = <name>
#   ./start.sh --no-gateway   # foreground, run pi binary directly (no supervisor)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

BOT_NAME="$(cat "$REPO_ROOT/runtime/agent/.bot-name" 2>/dev/null || echo pi)"
BIN_PATH="$REPO_ROOT/runtime/bin/$BOT_NAME"
GATEWAY_PATH="$REPO_ROOT/scripts/gateway.ts"

if [[ ! -e "$BIN_PATH" ]]; then
  echo "error: $BIN_PATH missing — run ./setup.sh first" >&2
  exit 1
fi
if [[ ! -f runtime/agent/telegram.json ]]; then
  echo "error: runtime/agent/telegram.json missing — run ./setup.sh first" >&2
  exit 1
fi

export PI_CODING_AGENT_DIR="$REPO_ROOT/runtime/agent"
export PI_TELEGRAM_CONFIG="$REPO_ROOT/runtime/agent/telegram.json"
export PI_MEMORY_DIR="$REPO_ROOT/runtime/agent/memory"
export QMD_CONFIG_DIR="$REPO_ROOT/runtime/qmd-config"
export XDG_CACHE_HOME="$REPO_ROOT/runtime/cache"
export PATH="$REPO_ROOT/runtime/bun/bin:$PATH"

# Build the actual command we'll run. Gateway is the default; --no-gateway
# falls back to the bare pi binary for debugging / parity with old behavior.
USE_GATEWAY=1
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-gateway) USE_GATEWAY=0 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [[ "$USE_GATEWAY" = "1" ]]; then
  CMD=(node --experimental-strip-types "$GATEWAY_PATH")
else
  CMD=("$BIN_PATH")
fi

if [[ "${1:-}" = "--tmux" ]]; then
  SESSION="${2:-$BOT_NAME}"
  mkdir -p "$REPO_ROOT/runtime/log"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  CMD_STR=$(printf "%q " "${CMD[@]}")
  tmux new-session -d -s "$SESSION" -x 200 -y 50 \
    "cd '$REPO_ROOT' && PI_CODING_AGENT_DIR='$PI_CODING_AGENT_DIR' PI_TELEGRAM_CONFIG='$PI_TELEGRAM_CONFIG' PI_MEMORY_DIR='$PI_MEMORY_DIR' QMD_CONFIG_DIR='$QMD_CONFIG_DIR' XDG_CACHE_HOME='$XDG_CACHE_HOME' PATH='$PATH' $CMD_STR 2>'$REPO_ROOT/runtime/log/$SESSION-stderr.log' | tee '$REPO_ROOT/runtime/log/$SESSION-tmux.log'"
  echo "tmux session '$SESSION' started; attach with: tmux attach -t $SESSION"
  echo "logs: runtime/log/$SESSION-{tmux,stderr}.log"
else
  exec "${CMD[@]}"
fi
