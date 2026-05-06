# Project: mybot

A consolidated monorepo for the dejay2/mybot Telegram coding-agent stack.

- `packages/agent`, `packages/ai`, `packages/coding-agent`, `packages/tui`, `packages/web-ui` — the pi runtime. Originally forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono); upstream link dropped, no longer tracking.
- `packages/telegram-bot` — Telegram bridge extension. Originally [dejay2/pi-telegram](https://github.com/dejay2/pi-telegram), now imported as a subtree.

See [AGENTS.md](AGENTS.md) for project-specific rules that apply to both humans and agents.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
