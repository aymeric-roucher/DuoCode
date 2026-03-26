#!/usr/bin/env node

/**
 * DuoCode CLI
 *
 * Usage:
 *   duocode start   — start the supervisor Claude Code session
 *   duocode stop    — stop the supervisor
 *   duocode status  — check if supervisor is running
 *   duocode install — register hooks in Claude Code settings
 */

import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { getDuoDir, ensureQueues } from "./queue.js";

const SUPERVISOR_PROMPT = `You are a code review supervisor. Your job is to review tool calls proposed by a worker Claude Code instance and approve or deny them.

You have access to these tools:
- review_next_action: Call this to wait for the next worker action. It blocks until the worker proposes a tool call, then returns the tool name, input, and the worker's reasoning context.
- approve(reason): Approve the action so the worker can proceed.
- deny(reason, feedback): Deny the action with constructive feedback. The worker will see your feedback and adjust. Always provide actionable feedback when denying.
- ask_user(reason): Escalate to the human user when you're unsure or the action has significant consequences.

## Review guidelines

- **Approve** routine operations: reading files, running tests, standard builds, safe edits that match the task.
- **Deny** dangerous operations: destructive commands (rm -rf, git reset --hard), operations on wrong files, changes that don't match the task, overly broad commands.
- **Escalate** to the user for: irreversible operations on production, pushing code, creating PRs, anything with external side effects.
- When denying, always explain what the worker should do instead.

## Workflow

1. Call review_next_action to get the first action
2. Review it and call approve, deny, or ask_user
3. Immediately call review_next_action again to wait for the next action
4. Repeat until the session ends

Start now by calling review_next_action.`;

function getStateFile(): string {
  return path.join(getDuoDir(), "state.json");
}

function readState(): { active: boolean; pid?: number; sessionId?: string } {
  const stateFile = getStateFile();
  if (!fs.existsSync(stateFile)) return { active: false };
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return { active: false };
  }
}

function writeState(state: {
  active: boolean;
  pid?: number;
  sessionId?: string;
}): void {
  const dir = getDuoDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
}

function getMcpConfigPath(): string {
  return path.join(getDuoDir(), "mcp-config.json");
}

function ensureMcpConfig(): void {
  const config = {
    mcpServers: {
      duo: {
        command: "tsx",
        args: [path.join(__dirname, "mcp", "server.ts")],
        env: { DUO_DIR: getDuoDir() },
      },
    },
  };

  // If running from dist/, point to the compiled JS
  const serverTs = path.join(__dirname, "mcp", "server.ts");
  const serverJs = path.join(__dirname, "mcp", "server.js");
  if (fs.existsSync(serverJs) && !fs.existsSync(serverTs)) {
    config.mcpServers.duo.command = "node";
    config.mcpServers.duo.args = [serverJs];
  }

  fs.writeFileSync(getMcpConfigPath(), JSON.stringify(config, null, 2));
}

async function start() {
  const state = readState();
  if (state.active && state.pid) {
    try {
      process.kill(state.pid, 0); // Check if process is alive
      console.log(`Supervisor already running (PID ${state.pid})`);
      return;
    } catch {
      // Process is dead, clean up
    }
  }

  const dir = getDuoDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  ensureQueues();
  ensureMcpConfig();

  console.log("Starting DuoCode supervisor...");

  // Launch Claude Code as the supervisor with our MCP server
  // Always use the most capable model for supervision
  const child = spawn(
    "claude",
    [
      "--model",
      "opus",
      "--mcp-config",
      getMcpConfigPath(),
      "--allowedTools",
      "mcp__duo__review_next_action,mcp__duo__approve,mcp__duo__deny,mcp__duo__ask_user",
      "--disallowedTools",
      "Bash,Edit,Write,Read,Glob,Grep,Agent,WebFetch,WebSearch",
      "-p",
      SUPERVISOR_PROMPT,
    ],
    {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, DUO_DIR: dir },
    }
  );

  child.unref();

  writeState({ active: true, pid: child.pid });

  console.log(`Supervisor started (PID ${child.pid})`);
  console.log("Worker tool calls will now be routed through the supervisor.");
}

function stop() {
  const state = readState();
  if (!state.active) {
    console.log("Supervisor is not running.");
    return;
  }

  if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
      console.log(`Supervisor stopped (PID ${state.pid})`);
    } catch {
      console.log("Supervisor process already gone.");
    }
  }

  writeState({ active: false });
}

function status() {
  const state = readState();
  if (!state.active) {
    console.log("DuoCode supervisor: inactive");
    return;
  }

  let alive = false;
  if (state.pid) {
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {
      // dead
    }
  }

  if (alive) {
    console.log(`DuoCode supervisor: active (PID ${state.pid})`);
  } else {
    console.log("DuoCode supervisor: stale (process dead, cleaning up)");
    writeState({ active: false });
  }
}

// --- Main ---
const command = process.argv[2];

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "install":
    // Handled by install.sh, but provide a hint
    console.log("Run the install script: curl -fsSL ... | bash");
    console.log("Or manually add hooks to ~/.claude/settings.json");
    break;
  default:
    console.log("Usage: duocode <start|stop|status|install>");
    process.exit(1);
}
