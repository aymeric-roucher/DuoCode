#!/usr/bin/env node

/**
 * DuoCode PreToolUse Hook
 *
 * Called by Claude Code before every tool use. Routes the action to the
 * supervisor via named pipes and waits for the decision.
 *
 * While waiting, shows a spinner on /dev/tty. If the user presses Escape,
 * the supervisor is bypassed and the normal permission dialog takes over.
 */

import fs from "fs";
import readline from "readline";
import path from "path";
import {
  ensureQueues,
  getActionQueuePath,
  getDecisionQueuePath,
  getDuoDir,
  readQueue,
  writeQueue,
} from "../queue.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  permission_mode: string;
}

// Tools that are auto-approved without supervisor review
const AUTO_APPROVE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoRead",
  "TodoWrite",
  "TaskList",
  "TaskGet",
  "TaskCreate",
  "TaskUpdate",
]);

// ── Spinner with Escape override ──

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Show a spinner on /dev/tty while waiting for the supervisor.
 * Returns a promise that resolves with:
 *   - { override: true } if user pressed Escape
 *   - { override: false } when cleanup() is called externally
 */
function startSpinner(toolName: string): {
  promise: Promise<{ override: boolean }>;
  cleanup: () => void;
} {
  let ttyFd: number | undefined;
  let ttyOut: fs.WriteStream | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let ttyIn: fs.ReadStream | undefined;
  let rlInterface: readline.Interface | undefined;
  let resolved = false;
  let resolvePromise: (val: { override: boolean }) => void;

  const promise = new Promise<{ override: boolean }>((resolve) => {
    resolvePromise = resolve;
  });

  try {
    // Open /dev/tty for direct terminal access (bypasses stdin/stdout redirection)
    ttyFd = fs.openSync("/dev/tty", "r");
    ttyOut = fs.createWriteStream("/dev/tty");
    ttyIn = fs.createReadStream("", { fd: ttyFd });

    // Show spinner
    let frame = 0;
    ttyOut.write(`\n${CYAN}${SPINNER_FRAMES[0]}${RESET} ${DIM}Supervisor reviewing: ${toolName}  (Esc to override)${RESET}`);

    interval = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      ttyOut!.write(`\r${CYAN}${SPINNER_FRAMES[frame]}${RESET} ${DIM}Supervisor reviewing: ${toolName}  (Esc to override)${RESET}`);
    }, 80);

    // Listen for Escape key
    if ("setRawMode" in ttyIn) (ttyIn as fs.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(true);
    rlInterface = readline.createInterface({ input: ttyIn });

    ttyIn.on("data", (data: Buffer) => {
      // Escape = 0x1b
      if (data[0] === 0x1b && !resolved) {
        resolved = true;
        cleanup();
        resolvePromise({ override: true });
      }
    });
  } catch {
    // If /dev/tty is not available (e.g., non-interactive), skip spinner
  }

  function cleanup() {
    if (interval) clearInterval(interval);
    if (ttyOut) {
      ttyOut.write("\r\x1b[K"); // Clear the spinner line
      try { ttyOut.end(); } catch { /* ignore */ }
    }
    if (ttyIn) {
      try { if ("setRawMode" in ttyIn) (ttyIn as fs.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(false); } catch { /* ignore */ }
      try { ttyIn.destroy(); } catch { /* ignore */ }
    }
    if (rlInterface) {
      try { rlInterface.close(); } catch { /* ignore */ }
    }
    if (!resolved) {
      resolved = true;
      resolvePromise({ override: false });
    }
  }

  return { promise, cleanup };
}

// ── Transcript context extraction ──

async function extractWorkerContext(
  transcriptPath: string,
  maxLines = 50
): Promise<string> {
  if (!fs.existsSync(transcriptPath)) return "";

  try {
    const lines: string[] = [];
    const stream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      lines.push(line);
    }

    const contextParts: string[] = [];
    const start = Math.max(0, lines.length - maxLines);

    for (let i = start; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!);
        if (entry.role === "assistant" && entry.content) {
          const textBlocks = Array.isArray(entry.content)
            ? entry.content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
            : [String(entry.content)];
          if (textBlocks.length > 0) {
            contextParts.push(textBlocks.join("\n"));
          }
        } else if (entry.role === "tool" && entry.content) {
          const text =
            typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
          const truncated =
            text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
          contextParts.push(`[Tool result]: ${truncated}`);
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    return contextParts.join("\n\n");
  } catch {
    return "";
  }
}


// ── Main ──

async function main() {
  // Only activate when launched by `duo` CLI (env var gating)
  if (process.env.DUO_ACTIVE !== "1") {
    process.exit(0);
  }

  // Read hook input from stdin
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input: HookInput = JSON.parse(chunks.join(""));

  // Auto-approve safe read-only tools
  if (AUTO_APPROVE_TOOLS.has(input.tool_name)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "DuoCode: auto-approved read-only tool",
        },
      })
    );
    process.exit(0);
  }

  ensureQueues();

  // Extract worker context from transcript
  const workerContext = await extractWorkerContext(input.transcript_path);

  // Write action to queue (unblocks supervisor's review_next_action)
  const action = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_use_id: input.tool_use_id,
    cwd: input.cwd,
    session_id: input.session_id,
    permission_mode: input.permission_mode,
    worker_context: workerContext,
  });

  await writeQueue(getActionQueuePath(), action);

  // Start spinner + Escape listener while waiting for supervisor
  const spinner = startSpinner(input.tool_name);

  // Race: supervisor decision vs user Escape
  const decisionPromise = readQueue(getDecisionQueuePath());

  const result = await Promise.race([
    decisionPromise.then((d) => ({ type: "decision" as const, data: d })),
    spinner.promise.then((s) =>
      s.override ? { type: "override" as const } : { type: "wait" as const }
    ),
  ]);

  if (result.type === "override") {
    // User pressed Escape — escalate to normal permission dialog
    spinner.cleanup();
    // We still need to consume the supervisor's decision when it arrives
    // so the FIFO doesn't block. Fire-and-forget read.
    decisionPromise.then(() => { }).catch(() => { });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "User overrode supervisor review",
        },
      })
    );
  } else if (result.type === "decision") {
    spinner.cleanup();
    process.stdout.write(result.data);
  } else {
    // Spinner finished without override — wait for actual decision
    const decision = await decisionPromise;
    spinner.cleanup();
    process.stdout.write(decision);
  }
}

main().catch((err) => {
  process.stderr.write(`DuoCode hook error: ${err}\n`);
  process.exit(1);
});
