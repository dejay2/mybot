#!/usr/bin/env bash
# setup.sh — bootstrap a self-contained mybot instance from a fresh clone.
#
# What it does:
#   1. npm install + build the pi binary (lives at packages/coding-agent/dist/pi).
#   2. Creates ./runtime/agent/ as pi's data dir (sessions, auth, models, etc.).
#   3. Symlinks ./packages/telegram-bot/ into runtime/agent/git/... so pi loads
#      the extension straight from this repo.
#   4. Writes the Telegram config at ./runtime/agent/telegram.json.
#
# After setup, run the bot via ./start.sh (which sets PI_CODING_AGENT_DIR and
# launches the binary from dist/). Everything stays inside the repo dir —
# nothing under ~/.local/, nothing under ~/.pi/.
#
# Usage:
#   ./setup.sh --bot-token <TOKEN> --user-id <NUMERIC_USER_ID>
#
# Required:
#   --bot-token   Bot token from BotFather.
#   --user-id     Numeric Telegram user id authorized to use the bot.
# Optional:
#   --skip-build  Reuse existing dist/pi (don't rebuild).
#   --skip-install Reuse existing node_modules (don't run npm install).
set -euo pipefail

BOT_TOKEN=""
USER_ID=""
SKIP_BUILD=0
SKIP_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token) BOT_TOKEN="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BOT_TOKEN" || -z "$USER_ID" ]]; then
  echo "error: --bot-token and --user-id are required" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

if [[ "$SKIP_INSTALL" = "0" ]]; then
  echo "==> npm install"
  npm install
fi

if [[ "$SKIP_BUILD" = "0" ]]; then
  echo "==> building pi binary"
  ( cd packages/coding-agent && npm run build:binary )
fi

if [[ ! -x packages/coding-agent/dist/pi ]]; then
  echo "error: packages/coding-agent/dist/pi missing or not executable" >&2
  exit 1
fi

RUNTIME_DIR="$REPO_ROOT/runtime/agent"
mkdir -p "$RUNTIME_DIR"
echo "    runtime dir: $RUNTIME_DIR"

EXTENSION_CACHE_DIR="$RUNTIME_DIR/git/github.com/dejay2/mybot-telegram-bot"
mkdir -p "$(dirname "$EXTENSION_CACHE_DIR")"
ln -sfn "$REPO_ROOT/packages/telegram-bot" "$EXTENSION_CACHE_DIR"
echo "    telegram-bot extension symlinked at runtime/agent/git/.../mybot-telegram-bot"

CONFIG_PATH="$RUNTIME_DIR/telegram.json"
cat > "$CONFIG_PATH" <<EOF
{
	"botToken": "$BOT_TOKEN",
	"botId": $(echo "$BOT_TOKEN" | cut -d: -f1),
	"allowedUserId": $USER_ID
}
EOF
chmod 600 "$CONFIG_PATH"
echo "    config written to $CONFIG_PATH"

echo ""
echo "done. start the bot with:"
echo "    ./start.sh"
