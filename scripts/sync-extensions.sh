#!/usr/bin/env bash
#
# sync-extensions.sh — idempotently align runtime/agent/settings.json's
# packages[] with the canonical pi-extension list shipped in this repo.
#
# Why: setup.sh only writes settings.json on first install (so it doesn't
# clobber per-machine additions). When new canonical packages are added to the
# repo, existing installs need this script to pick them up. Re-run safely.
#
# Behaviour:
#   - Adds any canonical package not already present (by string source).
#   - Never removes packages — preserves local additions and pinned versions.
#   - Recognizes both string ("npm:foo") and object ({source: "npm:foo", ...})
#     forms used by pi's settings filtering.
#   - Writes back as 2-space JSON; trailing newline.
#
# Usage:
#   ./scripts/sync-extensions.sh                # operates on $REPO_ROOT/runtime/agent
#   PI_CODING_AGENT_DIR=/path/to/agent ./scripts/sync-extensions.sh
#
# Followed by a bot restart so pi auto-installs the new npm packages.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$REPO_ROOT/runtime/agent}"
SETTINGS_PATH="$AGENT_DIR/settings.json"

if [[ ! -f "$SETTINGS_PATH" ]]; then
  echo "no settings.json at $SETTINGS_PATH" >&2
  echo "run ./setup.sh first, or set PI_CODING_AGENT_DIR" >&2
  exit 1
fi

# Canonical extension list. Keep in sync with the heredoc in setup.sh.
# Local-path entries (e.g. the telegram-bot subtree) are NOT canonical here:
# they're machine-specific and seeded by setup.sh on first install.
CANONICAL=(
  "npm:pi-web-access"
  "npm:pi-claude-bridge"
  "npm:pi-memory"
  "npm:pi-subagents"
  "npm:pi-mcp-adapter"
  "npm:pi-docparser"
  "npm:pi-schedule-prompt"
  "npm:pi-continue"
  "npm:pi-permission-system"
)

# Pre-flight: warn about project-local extensions in .pi/extensions/ whose
# names match canonical npm packages we're about to add. Pi auto-discovers
# .pi/extensions/<name>/ and .pi/extensions/<name>.ts, and loading both copies
# registers the same tools twice — pi then crash-loops on every session_start.
# The match is heuristic (by name only), but catches the common shadow-install
# pattern, e.g. .pi/extensions/pi-web-access/ alongside npm:pi-web-access.
EXT_DIR="$REPO_ROOT/.pi/extensions"
SHADOWS=()
for pkg in "${CANONICAL[@]}"; do
  spec="${pkg#npm:}"
  case "$spec" in
    @*/*) name="${spec#@*/}"; name="${name%@*}" ;;
    *)    name="${spec%@*}" ;;
  esac
  if [[ -d "$EXT_DIR/$name" ]]; then
    SHADOWS+=("$name (dir): $EXT_DIR/$name")
  elif [[ -f "$EXT_DIR/$name.ts" ]]; then
    SHADOWS+=("$name (file): $EXT_DIR/$name.ts")
  fi
done

if [[ ${#SHADOWS[@]} -gt 0 ]]; then
  {
    echo "[sync-extensions] error: shadow install(s) would clash with canonical npm packages:"
    for s in "${SHADOWS[@]}"; do
      echo "    $s"
    done
    echo ""
    echo "Pi auto-discovers .pi/extensions/<name>/ and .pi/extensions/<name>.ts."
    echo "Adding the matching npm:<name> entry would load both copies and crash pi."
    echo ""
    echo "Resolve by moving each shadow out of .pi/extensions/, e.g.:"
    echo "    mv .pi/extensions/<name> .pi/<name>.local-backup-\$(date +%Y%m%d)"
    echo ""
    echo "Then re-run this script."
  } >&2
  exit 2
fi

node - "$SETTINGS_PATH" "${CANONICAL[@]}" <<'NODE'
const fs = require("node:fs");
const [path, ...canonical] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
if (!Array.isArray(cfg.packages)) cfg.packages = [];
const have = new Set(
  cfg.packages.map((p) => (typeof p === "string" ? p : p && p.source)).filter(Boolean),
);
const added = [];
for (const pkg of canonical) {
  if (!have.has(pkg)) {
    cfg.packages.push(pkg);
    added.push(pkg);
  }
}
fs.writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
console.log(
  added.length === 0
    ? `[sync-extensions] up to date (${canonical.length} canonical, ${cfg.packages.length} total)`
    : `[sync-extensions] added ${added.length}: ${added.join(", ")}`,
);
console.log("[sync-extensions] restart the bot so pi auto-installs new npm packages");
NODE
