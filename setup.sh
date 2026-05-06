#!/usr/bin/env bash
# setup.sh — bootstrap a new mybot instance from a fresh clone.
#
# What it does:
#   1. Builds the pi binary and installs it under ~/.local/share/pi/.
#   2. Symlinks the local packages/telegram-bot/ checkout into pi's extension
#      cache (~/.pi/agent/git/...) so pi loads the extension straight from this
#      repo instead of cloning from GitHub. NOTE: pi runs `git pull` on /reload;
#      a future loader change will make this symlink hack unnecessary.
#   3. Writes the Telegram config at the chosen path.
#
# Usage:
#   ./setup.sh --bot-token <TOKEN> --user-id <NUMERIC_USER_ID> [--config <PATH>]
#
# Required:
#   --bot-token   Bot token from BotFather.
#   --user-id     Numeric Telegram user id of the user authorized to use the bot.
# Optional:
#   --config      Path to write the config JSON. Default: ~/.pi/agent/telegram.json
set -euo pipefail

BOT_TOKEN=""
USER_ID=""
CONFIG_PATH="$HOME/.pi/agent/telegram.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token) BOT_TOKEN="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --config) CONFIG_PATH="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BOT_TOKEN" || -z "$USER_ID" ]]; then
  echo "error: --bot-token and --user-id are required" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

echo "==> installing dependencies"
npm install

echo "==> building pi binary"
( cd packages/coding-agent && npm run build:binary )

LOCAL_PI_DIR="$HOME/.local/share/pi"
mkdir -p "$LOCAL_PI_DIR" "$HOME/.local/bin"
cp packages/coding-agent/dist/pi "$LOCAL_PI_DIR/pi"
cp packages/coding-agent/dist/package.json "$LOCAL_PI_DIR/package.json"
ln -sf "$LOCAL_PI_DIR/pi" "$HOME/.local/bin/pi"
echo "    pi installed at $LOCAL_PI_DIR/pi (symlinked to ~/.local/bin/pi)"

EXTENSION_CACHE_DIR="$HOME/.pi/agent/git/github.com/dejay2/mybot-telegram-bot"
mkdir -p "$(dirname "$EXTENSION_CACHE_DIR")"
ln -sfn "$REPO_ROOT/packages/telegram-bot" "$EXTENSION_CACHE_DIR"
echo "    telegram-bot extension symlinked at $EXTENSION_CACHE_DIR"

mkdir -p "$(dirname "$CONFIG_PATH")"
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
echo "    PI_TELEGRAM_CONFIG=$CONFIG_PATH pi"
