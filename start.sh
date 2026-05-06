#!/usr/bin/env bash
# start.sh — launch the bot from this repo with all state contained in ./runtime/.
#
# Sets PI_CODING_AGENT_DIR so pi reads sessions, auth, models config, and the
# extension cache from ./runtime/agent/ instead of ~/.pi/agent/. Sets
# PI_TELEGRAM_CONFIG so the telegram extension picks up the bot config.
#
# Usage:
#   ./start.sh                # foreground
#   ./start.sh --tmux <name>  # detached tmux session named <name>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

if [[ ! -x packages/coding-agent/dist/pi ]]; then
  echo "error: packages/coding-agent/dist/pi missing — run ./setup.sh first" >&2
  exit 1
fi
if [[ ! -f runtime/agent/telegram.json ]]; then
  echo "error: runtime/agent/telegram.json missing — run ./setup.sh first" >&2
  exit 1
fi

export PI_CODING_AGENT_DIR="$REPO_ROOT/runtime/agent"
export PI_TELEGRAM_CONFIG="$REPO_ROOT/runtime/agent/telegram.json"

if [[ "${1:-}" = "--tmux" ]]; then
  SESSION="${2:?--tmux requires a session name}"
  mkdir -p "$REPO_ROOT/runtime/log"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" -x 200 -y 50 \
    "cd '$REPO_ROOT' && PI_CODING_AGENT_DIR='$PI_CODING_AGENT_DIR' PI_TELEGRAM_CONFIG='$PI_TELEGRAM_CONFIG' ./packages/coding-agent/dist/pi 2>'$REPO_ROOT/runtime/log/$SESSION-stderr.log' | tee '$REPO_ROOT/runtime/log/$SESSION-tmux.log'"
  echo "tmux session '$SESSION' started; attach with: tmux attach -t $SESSION"
  echo "logs: runtime/log/$SESSION-{tmux,stderr}.log"
else
  exec ./packages/coding-agent/dist/pi
fi
