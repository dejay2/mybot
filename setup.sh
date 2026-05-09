#!/usr/bin/env bash
# setup.sh — bootstrap a self-contained mybot instance from a fresh clone.
#
# What it does:
#   1. npm install + build the pi binary (lives at packages/coding-agent/dist/pi).
#   2. Creates ./runtime/agent/ as pi's data dir (sessions, auth, models, memory).
#   3. Optionally bundles Bun + qmd under runtime/bun/ for memory search
#      (asks at the prompt; --with-search / --no-search to skip the prompt).
#   4. Symlinks ./runtime/bin/<NAME> -> packages/coding-agent/dist/pi so the
#      running process shows up as <NAME> in `ps` (no duplicate-pi collisions
#      across parallel installs).
#   5. Writes runtime/agent/settings.json registering pi-memory and the local
#      telegram-bot package.
#   6. Writes the Telegram config at runtime/agent/telegram.json.
#
# Everything lives inside ./runtime/ — pi state, bun, qmd, qmd's collection
# registry (runtime/qmd-config), qmd's model + index cache (runtime/cache).
# `cp -r` or `tar` the bot dir to move/duplicate; nothing under ~/.bun, ~/.pi,
# ~/.config/qmd, or ~/.cache/qmd is touched.
#
# Usage:
#   ./setup.sh --bot-token <TOKEN> --user-id <NUMERIC_USER_ID> [--name <NAME>]
#
# Required:
#   --bot-token   Bot token from BotFather.
#   --user-id     Numeric Telegram user id authorized to use the bot.
# Optional:
#   --name <foo>    Custom binary name (default: parent dir basename).
#                   Becomes runtime/bin/<NAME> and the default tmux session
#                   name. Only [a-z0-9_-] allowed.
#   --skip-build    Reuse existing dist/pi (don't rebuild).
#   --skip-install  Reuse existing node_modules (don't run npm install).
#   --with-search   Bundle Bun + qmd into runtime/bun/ for memory search.
#   --no-search     Skip Bun + qmd; basic memory still works.
#                   (If neither flag is passed, an interactive TTY is asked;
#                    a non-interactive run defaults to off.)
set -euo pipefail

BOT_TOKEN=""
USER_ID=""
SKIP_BUILD=0
SKIP_INSTALL=0
WITH_SEARCH=""
BOT_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token) BOT_TOKEN="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --name) BOT_NAME="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --with-search) WITH_SEARCH=1; shift ;;
    --no-search) WITH_SEARCH=0; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BOT_TOKEN" || -z "$USER_ID" ]]; then
  echo "error: --bot-token and --user-id are required" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Decide the bot name. Default = repo dir basename, sanitized.
sanitize_name() {
  # lowercase, replace anything that isn't [a-z0-9_-] with '-', collapse runs
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9_-]/-/g' -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//'
}
DEFAULT_BOT_NAME="$(sanitize_name "$(basename "$REPO_ROOT")")"
[[ -z "$DEFAULT_BOT_NAME" ]] && DEFAULT_BOT_NAME="bot"

if [[ -z "$BOT_NAME" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    read -r -p "Name for this bot binary (becomes runtime/bin/<NAME> and default tmux session)? [$DEFAULT_BOT_NAME] " ANSWER
    BOT_NAME="${ANSWER:-$DEFAULT_BOT_NAME}"
  else
    BOT_NAME="$DEFAULT_BOT_NAME"
  fi
fi
BOT_NAME="$(sanitize_name "$BOT_NAME")"
if [[ -z "$BOT_NAME" ]]; then
  echo "error: bot name is empty after sanitization" >&2
  exit 2
fi
echo "    bot name: $BOT_NAME"

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
mkdir -p \
  "$RUNTIME_DIR" \
  "$RUNTIME_DIR/memory" \
  "$REPO_ROOT/runtime/bin" \
  "$REPO_ROOT/runtime/cache" \
  "$REPO_ROOT/runtime/qmd-config" \
  "$REPO_ROOT/runtime/control" \
  "$REPO_ROOT/runtime/log"
echo "    runtime dir: $RUNTIME_DIR"

# Seed an empty cron schedule so scripts/gateway.ts can run with no tasks.
CRON_PATH="$REPO_ROOT/runtime/cron.json"
if [[ ! -f "$CRON_PATH" ]]; then
  echo '{"tasks":[]}' > "$CRON_PATH"
  echo "    cron file:  $CRON_PATH (empty)"
fi

# Symlink the renamed binary. Relative target survives `cp -r runtime/` and
# `tar`-and-move; the resolved exe path is dist/pi (so pi finds its
# package.json), but argv[0] = ./runtime/bin/<NAME> so `ps aux` shows the
# bot's name, not "pi".
BIN_LINK="$REPO_ROOT/runtime/bin/$BOT_NAME"
ln -sfn "../../packages/coding-agent/dist/pi" "$BIN_LINK"
echo "    binary:    $BIN_LINK -> packages/coding-agent/dist/pi"

# Persist the chosen name so start.sh picks it up without re-asking.
echo "$BOT_NAME" > "$RUNTIME_DIR/.bot-name"

# Decide whether to bundle Bun + qmd for memory search.
if [[ -z "$WITH_SEARCH" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    echo ""
    echo "Memory search powered by qmd enables:"
    echo "  - Semantic + hybrid search across MEMORY.md and daily logs"
    echo "  - Selective injection: relevant past notes auto-surface every turn"
    echo "  - Adds Bun (~50MB) + qmd to ./runtime/bun/ (gitignored)"
    echo ""
    read -r -p "Bundle qmd + Bun for memory search? [Y/n] " ANSWER
    case "${ANSWER,,}" in
      n|no) WITH_SEARCH=0 ;;
      *)    WITH_SEARCH=1 ;;
    esac
  else
    echo "==> non-interactive setup; skipping Bun + qmd (pass --with-search to enable)"
    WITH_SEARCH=0
  fi
fi

BUN_DIR="$REPO_ROOT/runtime/bun"

if [[ "$WITH_SEARCH" = "1" ]]; then
  mkdir -p "$BUN_DIR/bin"
  if [[ ! -x "$BUN_DIR/bin/bun" ]]; then
    echo "==> installing Bun into $BUN_DIR (one-time)"
    # Env vars must attach to `bash`, not `curl` (separate processes across the
    # pipe). PATH prepend ensures the installer's "already-in-PATH" early-exit
    # fires after the binary lands, so it skips touching ~/.bashrc / ~/.zshrc.
    curl -fsSL https://bun.sh/install | env BUN_INSTALL="$BUN_DIR" PATH="$BUN_DIR/bin:$PATH" bash
  else
    echo "    Bun already present at $BUN_DIR/bin/bun"
  fi
  if [[ ! -x "$BUN_DIR/bin/bun" ]]; then
    echo "error: Bun install did not land at $BUN_DIR/bin/bun" >&2
    exit 1
  fi
  # `bun install -g` is unreliable when invoked from any tree with a
  # parent package.json (it falls into workspace mode and skips the global
  # symlink). We side-step that by cloning qmd into runtime/bun/qmd-src/,
  # running `bun install --no-save` there to fetch its deps, building the
  # CLI bundle, and symlinking the resulting bin/qmd into runtime/bun/bin/.
  QMD_DIR="$BUN_DIR/qmd-src"
  if [[ ! -e "$BUN_DIR/bin/qmd" || ! -f "$QMD_DIR/dist/cli/qmd.js" ]]; then
    echo "==> installing qmd into $QMD_DIR (one-time)"
    if [[ ! -d "$QMD_DIR/.git" ]]; then
      rm -rf "$QMD_DIR"
      git clone --depth 1 https://github.com/tobi/qmd "$QMD_DIR"
    fi
    ( cd "$QMD_DIR" && "$BUN_DIR/bin/bun" install --no-save )
    ( cd "$QMD_DIR" && "$BUN_DIR/bin/bun" run build )
    ln -sf "$QMD_DIR/bin/qmd" "$BUN_DIR/bin/qmd"
  else
    echo "    qmd already present at $BUN_DIR/bin/qmd"
  fi
fi

# Register the canonical pi extensions and the local telegram-bot package. Pi's
# package manager treats anything that isn't npm:/git:/etc. as a local path and
# loads from disk directly — no clone, no pull, no symlink hack.
# Order matters: memory + web-access run early (their before_agent_start hooks
# register first), so their context-injection blocks land above the Telegram
# bridge's suffix. The canonical list lives in scripts/sync-extensions.sh too —
# keep them in sync. Run `./scripts/sync-extensions.sh` on existing installs
# to add new entries without clobbering local additions.
SETTINGS_PATH="$RUNTIME_DIR/settings.json"
if [[ ! -f "$SETTINGS_PATH" ]]; then
  cat > "$SETTINGS_PATH" <<EOF
{
  "packages": [
    "npm:pi-web-access",
    "npm:pi-claude-bridge",
    "npm:pi-memory",
    "npm:pi-subagents",
    "npm:pi-mcp-adapter",
    "npm:pi-docparser",
    "npm:pi-schedule-prompt",
    "npm:pi-continue",
    "npm:pi-permission-system",
    "$REPO_ROOT/packages/telegram-bot"
  ]
}
EOF
  echo "    settings.json created with canonical pi extensions + local telegram-bot"
else
  echo "    settings.json already exists; leaving package list alone"
  echo "    (run ./scripts/sync-extensions.sh to add any newly-canonical packages)"
fi

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

# Seed pi-permission-system with allow-by-default. Without this file, the
# extension prompts via UI for every tool/bash/mcp/skill call — for an
# unattended Telegram bot that surfaces in chat as a confirmation flood.
# Access is already gated by allowedUserId in telegram.json. Tighten later
# by adding per-pattern rules (e.g. bash "rm -rf *": deny).
PERMISSIONS_PATH="$RUNTIME_DIR/pi-permissions.jsonc"
if [[ ! -f "$PERMISSIONS_PATH" ]]; then
  cat > "$PERMISSIONS_PATH" <<'EOF'
{
  "defaultPolicy": {
    "tools": "allow",
    "bash": "allow",
    "mcp": "allow",
    "skills": "allow",
    "special": "allow"
  }
}
EOF
  echo "    pi-permissions.jsonc seeded (allow-by-default; tighten in $PERMISSIONS_PATH)"
fi

echo ""
echo "done. start the bot with:"
echo "    ./start.sh"
