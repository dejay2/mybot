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
