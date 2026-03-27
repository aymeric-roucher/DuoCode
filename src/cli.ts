#!/usr/bin/env node

/**
 * DuoCode CLI
 *
 * Usage:
 *   duo                — interactive mode: start supervisor + worker
 *   duo "fix the bug"  — direct mode: pass prompt to worker
 *   duo stop           — stop a running supervisor
 *   duo status         — check supervisor status
 *   duo whatsapp-login — one-time WhatsApp QR code login
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn, type ChildProcess } from "child_process";
import { getDuoDir, ensureQueues, getQuestionQueuePath, getAnswerQueuePath, readQueue, writeQueue } from "./queue.js";
import { whatsappLogin } from "./whatsapp/login.js";
import { createWhatsAppClient, type WhatsAppClient } from "./whatsapp/client.js";
import { webAuthExists } from "./whatsapp/session.js";

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

const SUPERVISOR_PROMPT = `You are a code review supervisor. You review every tool call proposed by a worker Claude Code instance.

You own every line of code that ships. The worker WILL cut corners — your job is to catch it.
Your default posture is skepticism. If you're approving everything, you're not doing your job.

## When to DENY

1. **Destructive commands** — rm -rf, git reset --hard, force push, DROP TABLE, git checkout, git stash
2. **Scope drift** — worker drifting from the assigned task
3. **Silent error handling** — try/catch that swallows errors, .catch(() => {})
4. **Test deletion without fix** — never approve skipping failing tests
5. **Unnecessary abstraction** — wrapper functions, "improvements" beyond what was asked
6. **Unexplained large diff** — too large to understand; ask worker to explain
7. **Whenever you're not happy with the agent's direction** — provide detailed guidance on what to do instead

## When to APPROVE

- The action **directly advances the assigned task**
- The code is **minimal, correct, and tested**
- You **understand what the change does and why**

## When to ASK USER

- Irreversible operations on production
- Pushing code, creating PRs, anything with external side effects
- Ambiguous requirements where shipping the wrong thing wastes effort
- Use sparingly — only for true blockers, not routine decisions

## Frontend work

When the task involves frontend changes, instruct the worker to render the result as a PNG screenshot and provide the file path so you can inspect it visually.

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
  const installDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    ".."
  );
  const serverPath = path.join(installDir, "src", "mcp", "server.ts");

  const config = {
    mcpServers: {
      duo: {
        command: "npx",
        args: ["--prefix", installDir, "tsx", serverPath],
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

function startSupervisor(userTask?: string): ChildProcess {
  const dir = getDuoDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  ensureQueues();
  ensureMcpConfig();

  const child = spawn(
    "claude",
    [
      "--model",
      "opus",
      "--mcp-config",
      getMcpConfigPath(),
      "--allowedTools",
      "mcp__duo__review_next_action,mcp__duo__approve,mcp__duo__deny,mcp__duo__guide_worker,mcp__duo__ask_user,mcp__duo__escalate_to_user",
      "--disallowedTools",
      "Bash,Edit,Write,Read,Glob,Grep,Agent,WebFetch,WebSearch",
      "-p",
      userTask
        ? `${SUPERVISOR_PROMPT}\n\n## Worker's assigned task\n\n${userTask}`
        : SUPERVISOR_PROMPT,
    ],
    {
      stdio: [
        "ignore",
        fs.openSync(path.join(dir, "supervisor.log"), "w"),
        fs.openSync(path.join(dir, "supervisor.log"), "a"),
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

// ── Question listener (blocks on FIFO, prompts user via /dev/tty) ──

async function listenForQuestions(whatsapp: WhatsAppClient | null): Promise<void> {
  while (true) {
    // Block until the supervisor asks a question
    const raw = await readQueue(getQuestionQueuePath());
    let question: string;
    try {
      const parsed = JSON.parse(raw);
      question = parsed.question ?? raw;
    } catch {
      question = raw;
    }

    let answer: string;

    if (whatsapp?.userJid) {
      // Send via WhatsApp and wait for reply
      const prefix = "[DuoCode Supervisor]";
      answer = await whatsapp.sendAndWaitForReply(
        whatsapp.userJid,
        `${prefix} ${question}`,
        5 * 60_000
      );
    } else {
      // Prompt via terminal with audio ping
      try {
        // Audio ping — bell character
        const ttyOut = fs.createWriteStream("/dev/tty");
        ttyOut.write(`\n${CYAN}${BOLD}  ┃ Supervisor question:${RESET} ${question}\n`);
        ttyOut.write("\x07"); // terminal bell
        ttyOut.end();
      } catch { /* no tty */ }

      // Read answer from /dev/tty
      answer = await new Promise<string>((resolve) => {
        const ttyIn = fs.createReadStream("/dev/tty", { encoding: "utf-8" });
        const rl = readline.createInterface({ input: ttyIn });
        rl.question(`${CYAN}  ┃ Your answer: ${RESET}`, (ans) => {
          rl.close();
          ttyIn.destroy();
          resolve(ans);
        });
      });
    }

    // Write answer back to supervisor
    await writeQueue(getAnswerQueuePath(), answer);
  }
}

// ── Worker (the user-facing Claude Code) ──

function launchWorker(prompt: string | undefined): void {
  const args: string[] = [];

  if (prompt) {
    args.push(prompt);
  }

  // Spawn worker as a foreground child, inheriting the terminal.
  const worker = spawn("claude", args, {
    stdio: "inherit",
  });

  // Write worker PID so hook.sh can check PPID against it
  const pidFile = path.join(getDuoDir(), "worker.pid");
  if (worker.pid) fs.writeFileSync(pidFile, String(worker.pid));

  worker.on("exit", (code) => {
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
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

if (command === "whatsapp-login") {
  const authDir = path.join(getDuoDir(), "whatsapp-auth");
  await whatsappLogin(authDir);
  await new Promise((r) => setTimeout(r, 1000));
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

// Parse prompt before starting supervisor (so supervisor knows the task)
const prompt = cliArgs.length > 0 ? cliArgs.join(" ") : undefined;

// Start or reuse supervisor
const state = readState();
if (isSupervisorAlive(state)) {
  console.log(`${DIM}  Supervisor already running (PID ${state.pid})${RESET}`);
} else {
  const child = startSupervisor(prompt);
  console.log(`${GREEN}  Supervisor started${RESET} ${DIM}(PID ${child.pid})${RESET}`);
}
console.log("");

// Launch worker
launchWorker(prompt);

// TODO: question listener disabled — readQueue blocks the event loop on openSync
// listenForQuestions(whatsapp).catch(() => {});
