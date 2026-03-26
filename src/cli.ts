#!/usr/bin/env node

/**
 * DuoCode CLI
 *
 * Usage:
 *   duo                — interactive mode: start supervisor + worker
 *   duo "fix the bug"  — direct mode: pass prompt to worker
 *   duo stop           — stop a running supervisor
 *   duo status         — check supervisor status
 */

import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { getDuoDir, ensureQueues } from "./queue.js";

// ── Branding ──

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";

function printHeader() {
  console.log("");
  console.log(`${CYAN}${BOLD}  ╭──────────────────────────────╮${RESET}`);
  console.log(`${CYAN}${BOLD}  │         DuoCode v1.0         │${RESET}`);
  console.log(`${CYAN}${BOLD}  ╰──────────────────────────────╯${RESET}`);
  console.log(`${DIM}  Supervisor: Opus  │  Worker: your default model${RESET}`);
  console.log(`${DIM}  Press Escape during review to take manual control${RESET}`);
  console.log("");
}

// ── Supervisor prompt ──

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

// ── State management ──

interface DuoState {
  active: boolean;
  pid?: number;
}

function getStateFile(): string {
  return path.join(getDuoDir(), "state.json");
}

function readState(): DuoState {
  const stateFile = getStateFile();
  if (!fs.existsSync(stateFile)) return { active: false };
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return { active: false };
  }
}

function writeState(state: DuoState): void {
  const dir = getDuoDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
}

// ── MCP config ──

function getMcpConfigPath(): string {
  return path.join(getDuoDir(), "mcp-config.json");
}

function ensureMcpConfig(): void {
  const srcServer = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "mcp",
    "server.ts"
  );
  const distServer = srcServer.replace(/\.ts$/, ".js");

  const serverPath = fs.existsSync(distServer) ? distServer : srcServer;
  const command = serverPath.endsWith(".ts") ? "tsx" : "node";

  const config = {
    mcpServers: {
      duo: {
        command,
        args: [serverPath],
        env: { DUO_DIR: getDuoDir() },
      },
    },
  };

  fs.writeFileSync(getMcpConfigPath(), JSON.stringify(config, null, 2));
}

// ── Supervisor lifecycle ──

function isSupervisorAlive(state: DuoState): boolean {
  if (!state.active || !state.pid) return false;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startSupervisor(): ChildProcess {
  const dir = getDuoDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  ensureQueues();
  ensureMcpConfig();

  const logFile = path.join(dir, "supervisor.log");

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
      stdio: [
        "ignore",
        fs.openSync(logFile, "w"),
        fs.openSync(logFile, "a"),
      ],
      detached: true,
      env: { ...process.env, DUO_DIR: dir },
    }
  );

  child.unref();
  writeState({ active: true, pid: child.pid });
  return child;
}

function stopSupervisor(): void {
  const state = readState();
  if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  writeState({ active: false });
}

// ── Worker (the user-facing Claude Code) ──

function launchWorker(prompt: string | undefined): void {
  const args: string[] = [];

  if (prompt) {
    args.push(prompt);
  }

  // Spawn worker as a foreground child, inheriting the terminal.
  // DUO_ACTIVE=1 tells the global hook to activate.
  const worker = spawn("claude", args, {
    stdio: "inherit",
    env: { ...process.env, DUO_ACTIVE: "1" },
  });

  worker.on("exit", (code) => {
    stopSupervisor();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => worker.kill("SIGINT"));
  process.on("SIGTERM", () => {
    worker.kill("SIGTERM");
    stopSupervisor();
  });
}

// ── Main ──

const cliArgs = process.argv.slice(2);
const command = cliArgs[0];

if (command === "stop") {
  stopSupervisor();
  console.log(`${GREEN}Supervisor stopped.${RESET}`);
  process.exit(0);
}

if (command === "status") {
  const state = readState();
  if (isSupervisorAlive(state)) {
    console.log(`${GREEN}DuoCode supervisor: active${RESET} ${DIM}(PID ${state.pid})${RESET}`);
  } else {
    console.log(`${DIM}DuoCode supervisor: inactive${RESET}`);
    if (state.active) writeState({ active: false });
  }
  process.exit(0);
}

// Default: start duo session
printHeader();

// Start or reuse supervisor
const state = readState();
if (isSupervisorAlive(state)) {
  console.log(`${DIM}  Supervisor already running (PID ${state.pid})${RESET}`);
} else {
  const child = startSupervisor();
  console.log(`${GREEN}  Supervisor started${RESET} ${DIM}(PID ${child.pid})${RESET}`);
}
console.log("");

// Launch worker
const prompt = cliArgs.length > 0 ? cliArgs.join(" ") : undefined;
launchWorker(prompt);
