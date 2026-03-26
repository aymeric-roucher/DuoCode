#!/usr/bin/env node

/**
 * DuoCode PreToolUse Hook
 *
 * Called by Claude Code before every tool use. Reads the hook input from stdin,
 * extracts worker context from the transcript, writes the action to action.queue,
 * and blocks reading the supervisor's decision from decision.queue.
 *
 * If DuoCode is disabled (no action.queue exists), exits silently (no opinion).
 */

import fs from "fs";
import readline from "readline";
import {
  ensureQueues,
  getActionQueuePath,
  getDecisionQueuePath,
  getDuoDir,
  readQueue,
  writeQueue,
} from "../queue.js";
import path from "path";

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

// Auto-approved tools that don't need supervisor review
const AUTO_APPROVE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoRead",
  "TodoWrite",
  "TaskList",
  "TaskGet",
]);

/** Read the last N lines of the transcript since the last hook marker */
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

    // Walk backwards from the end, collect assistant text and tool results
    // until we hit the previous hook marker or run out of lines
    const contextParts: string[] = [];
    const start = Math.max(0, lines.length - maxLines);

    for (let i = start; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role === "assistant" && entry.content) {
          // Extract text blocks from assistant messages
          const textBlocks = Array.isArray(entry.content)
            ? entry.content
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { text: string }) => b.text)
            : [String(entry.content)];
          if (textBlocks.length > 0) {
            contextParts.push(textBlocks.join("\n"));
          }
        } else if (entry.role === "tool" && entry.content) {
          // Summarize tool results briefly
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

/** Check if DuoCode is active (queues exist and supervisor is running) */
function isDuoActive(): boolean {
  const stateFile = path.join(getDuoDir(), "state.json");
  if (!fs.existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    return state.active === true;
  } catch {
    return false;
  }
}

async function main() {
  // Read hook input from stdin
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input: HookInput = JSON.parse(chunks.join(""));

  // If DuoCode not active, exit with no opinion
  if (!isDuoActive()) {
    process.exit(0);
  }

  // Auto-approve safe read-only tools
  if (AUTO_APPROVE_TOOLS.has(input.tool_name)) {
    const result = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "DuoCode: auto-approved read-only tool",
      },
    };
    process.stdout.write(JSON.stringify(result));
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

  // Block reading decision from queue (until supervisor approves/denies)
  const decision = await readQueue(getDecisionQueuePath());

  // Pass decision through to Claude Code
  process.stdout.write(decision);
}

main().catch((err) => {
  process.stderr.write(`DuoCode hook error: ${err}\n`);
  // Exit with non-2 code so Claude Code continues normally
  process.exit(1);
});
