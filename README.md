<p align="center">
  <a href="https://pi.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pi.dev/logo.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://huggingface.co/buckets/julien-c/my-training-bucket/resolve/pi-logo-dark.svg">
      <img alt="pi logo" src="https://pi.dev/logo.svg" width="128">
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Pi Monorepo

> **Looking for the pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents.

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |

## Chat bot workflows

For Slack/chat automation, see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## Mybot Telegram bot — self-contained install

`./setup.sh` produces a fully self-contained bot under `./runtime/`. Nothing under `~/.bun`, `~/.pi`, `~/.config/qmd`, or `~/.cache/qmd` is touched. `cp -r` or `tar` the bot dir to move/duplicate it across machines.

### Naming

Setup asks for a bot name (default: parent dir basename, sanitized). The chosen name becomes:

- `runtime/bin/<NAME>` — relative symlink → `packages/coding-agent/dist/pi`. Invoked by `start.sh`, so `ps aux` shows your bot name (no duplicate-`pi` collisions across parallel installs).
- The default tmux session name when you run `./start.sh --tmux`.

Override at install time with `--name <foo>`.

### Memory (pi-memory)

`./setup.sh` registers [`pi-memory`](https://github.com/jayzeng/pi-memory) by default. Memory files live at `runtime/agent/memory/`:

- `MEMORY.md` — curated long-term facts, decisions, preferences
- `SCRATCHPAD.md` — open checklist items
- `daily/<YYYY-MM-DD>.md` — append-only working logs

Tools available to the agent every turn: `memory_write`, `memory_read`, `scratchpad`, `memory_search`. The `## Memory` block is injected into the system prompt automatically.

### Memory search (qmd + Bun)

Setup asks whether to bundle [Bun](https://bun.sh) + [`qmd`](https://github.com/tobi/qmd) for semantic search and selective injection (relevant past notes auto-surfacing each turn). Skip with `--no-search` (e.g. CI/Docker), force with `--with-search`. Without qmd, the four tools still work; only semantic search and selective injection are unavailable. The first semantic search lazily downloads an embedding model.

Per-install isolation:

- `runtime/qmd-config/` — qmd collection registry (`QMD_CONFIG_DIR`)
- `runtime/cache/qmd/` — qmd index sqlite + GGUF model files (`XDG_CACHE_HOME`)
- `runtime/bun/` — bundled Bun + qmd source

Each install has its own collection registry, so two parallel bots on the same machine don't collide on the `pi-memory` collection name.

## License

MIT
