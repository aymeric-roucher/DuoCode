# DuoCode

An LLM supervisor for Claude Code. Run `duo` instead of `claude` — a second Claude Code instance (Opus) reviews and approves/denies every tool call, using your existing credits.

## How it works

```
You run:  duo "fix the auth bug"

Worker Claude Code                    Supervisor Claude Code (Opus)
  │                                     │
  ├─ wants to run Edit ──── hook ──────▶│
  │  ⠋ Supervisor reviewing: Edit       │ reviews action + worker context
  │    (Esc to override)                │
  │                                     ├─ approve("safe edit")
  │◀────────────────────────────────────┘
  │  resumes                            │
  │                                     │ review_next_action (blocks)
  ├─ wants to run Bash ──── hook ──────▶│
  │  ⠋ Supervisor reviewing: Bash       │
  │                                     ├─ deny("too broad",
  │                                     │   "use npm test instead")
  │◀────────────────────────────────────┘
  │  gets feedback, adjusts             ...
```

The supervisor is a persistent Claude Code session with only 4 MCP tools: `review_next_action`, `approve`, `deny`, and `ask_user`. Its context stays warm across reviews — it builds up understanding of the worker's task over time.

Read-only tools (Read, Glob, Grep) are auto-approved without review.

**Press Escape** during the review spinner to take manual control.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/aymeric-roucher/DuoCode/main/install.sh | bash
```

This:
- Clones DuoCode to `~/.local/share/duocode/`
- Registers a `PreToolUse` hook in `~/.claude/settings.json`
- Installs the `duo` CLI to `~/.local/bin/`

No additional API key — uses your existing Claude Code credentials.

## Usage

```bash
duo                  # interactive session with supervisor
duo "fix the bug"    # direct mode with a prompt
duo stop             # stop the supervisor
duo status           # check if supervisor is running
```

## Architecture

```
~/.local/bin/duo              CLI entry point
~/.local/share/duocode/       source code
~/.claude/hooks/duo/
  ├── hook.sh                 PreToolUse hook (registered in settings.json)
  ├── mcp-config.json         MCP server config for supervisor
  ├── state.json              supervisor PID + active flag
  ├── action.queue            queue: hook → MCP server
  └── decision.queue          queue: MCP server → hook
```

- **CLI** (`src/cli.ts`) — starts supervisor (Opus, background), then launches worker (`claude`) in foreground
- **Hook** (`src/hooks/pre-tool-use.ts`) — intercepts tool calls, sends to supervisor via queue, shows spinner with Escape override
- **MCP server** (`src/mcp/server.ts`) — runs inside the supervisor Claude Code. Reads actions from the queue, presents them to the supervisor, writes decisions back. Exposes `review_next_action`, `approve`, `deny`, `ask_user`.
- **Queues** (`action.queue`, `decision.queue`) — synchronization between hook and MCP server. Zero overhead, no polling.

## Supervisor model

The supervisor always uses `opus` (latest Opus model) for maximum reasoning capability. The worker can use any model.

## Uninstall

```bash
rm ~/.local/bin/duo
rm -rf ~/.local/share/duocode
rm -rf ~/.claude/hooks/duo
# Then remove the PreToolUse hook entry from ~/.claude/settings.json
```
