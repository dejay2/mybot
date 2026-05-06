#!/usr/bin/env bash
# dev/sync.sh — rebuild patched pi binary, install locally, optionally scp to remote, restart test bot.
#
# Usage:
#   ./dev/sync.sh                  # rebuild + install locally + restart tmux pi-test
#   ./dev/sync.sh --remote ghe     # also scp to ghe:~/.local/share/pi/
#   ./dev/sync.sh --no-restart     # skip the tmux restart
set -euo pipefail

REMOTE=""
RESTART=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE="$2"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> building pi binary"
( cd packages/coding-agent && npm run build:binary )

LOCAL_PI_DIR="$HOME/.local/share/pi"
mkdir -p "$LOCAL_PI_DIR"
echo "==> installing to $LOCAL_PI_DIR"
cp packages/coding-agent/dist/pi "$LOCAL_PI_DIR/pi"
cp packages/coding-agent/dist/package.json "$LOCAL_PI_DIR/package.json"
ln -sf "$LOCAL_PI_DIR/pi" "$HOME/.local/bin/pi"

if [[ -n "$REMOTE" ]]; then
  echo "==> scp to $REMOTE:~/.local/share/pi/"
  ssh "$REMOTE" "mkdir -p ~/.local/share/pi"
  scp packages/coding-agent/dist/pi "$REMOTE:~/.local/share/pi/pi"
  scp packages/coding-agent/dist/package.json "$REMOTE:~/.local/share/pi/package.json"
fi

if [[ "$RESTART" = "1" ]] && tmux has-session -t pi-test 2>/dev/null; then
  echo "==> restarting tmux pi-test"
  tmux send-keys -t pi-test C-c
  sleep 1
  tmux send-keys -t pi-test "PI_TELEGRAM_CONFIG=$HOME/.pi/agent/telegram-test.json pi 2>/tmp/pi-testbot/stderr.log | tee /tmp/pi-testbot/tmux.log" Enter
fi

echo "done."
