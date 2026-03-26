# DuoCode

An LLM supervisor for Claude Code. A second Claude Code instance (Opus) reviews and approves/denies every tool call made by your worker Claude Code session — using your existing Claude credits.

## How it works

```
Worker Claude Code                    Supervisor Claude Code (Opus)
  │                                     │
  ├─ wants to run Edit ──── hook ──────▶│
  │  (blocks)                           │ reviews action + worker context
  │                                     │
  │                                     ├─ approve("safe edit") ──▶│
  │◀────────────────────────────────────┘                          │
  │  resumes                            │                          │
  │                                     │ calls review_next_action │
  ├─ wants to run Bash ──── hook ──────▶│ (blocks until next call) │
  │  (blocks)                           │                          │
  │                                     ├─ deny("too broad",      │
  │                                     │   "use npm test instead")│
  │◀────────────────────────────────────┘                          │
  │  gets feedback, adjusts             ...
```

The supervisor is a persistent Claude Code session with only 4 MCP tools: `review_next_action`, `approve`, `deny`, and `ask_user`. Its context stays warm across reviews — it builds up understanding of the worker's task over time.

Read-only tools (Read, Glob, Grep) are auto-approved without supervisor review.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/aymeric-roucher/DuoCode/main/install.sh | bash
```

This:
- Clones DuoCode to `~/.local/share/duocode/`
- Registers a `PreToolUse` hook in `~/.claude/settings.json`
- Installs `/duo-start`, `/duo-stop`, `/duo-status` slash commands

No additional API key needed — uses your existing Claude Code credentials.

## Usage

Start the supervisor before (or during) a Claude Code session:

```bash
# From terminal
duocode start

# Or from inside Claude Code
/duo-start
```

Then use Claude Code normally. Write operations will be reviewed by the supervisor.

```bash
duocode stop      # stop supervisor
duocode status    # check if running
```

## Architecture

- **PreToolUse hook** (`src/hooks/pre-tool-use.ts`) — fires on every tool call. Writes the action to a named pipe, blocks reading the decision.
- **MCP server** (`src/mcp/server.ts`) — runs inside the supervisor Claude Code. Reads actions from the pipe, presents them to the supervisor, writes decisions back.
- **Named pipes** (`action.queue`, `decision.queue`) — synchronization between hook and MCP server. Zero overhead, no polling.

## Supervisor model

The supervisor always uses `opus` (latest Opus model) for maximum reasoning capability. The worker can use any model.

## Uninstall

```bash
# Remove hooks from settings
# Remove skills
rm -rf ~/.local/share/duocode
rm -rf ~/.claude/hooks/duo
rm ~/.claude/skills/duo-start.md ~/.claude/skills/duo-stop.md ~/.claude/skills/duo-status.md
```
