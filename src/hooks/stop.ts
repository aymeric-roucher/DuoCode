#!/usr/bin/env node

/**
 * DuoCode Stop Hook
 *
 * Called when the worker Claude Code finishes. Sends the worker's final output
 * to the supervisor for review. The supervisor can either let it stop or
 * redirect with feedback (prevents the stop, injects guidance).
 */

import fs from "fs";
import readline from "readline";
import {
  ensureQueues,
  getActionQueuePath,
  getDecisionQueuePath,
  writeQueue,
  readQueue,
} from "../queue.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

async function extractRecentOutput(
  transcriptPath: string,
  maxLines = 30
): Promise<string> {
  if (!fs.existsSync(transcriptPath)) return "";
  try {
    const lines: string[] = [];
    const stream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      lines.push(line);
    }
    const parts: string[] = [];
    const start = Math.max(0, lines.length - maxLines);
    for (let i = start; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!);
        if (entry.role === "assistant" && entry.content) {
          const texts = Array.isArray(entry.content)
            ? entry.content
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { text: string }) => b.text)
            : [String(entry.content)];
          if (texts.length > 0) parts.push(texts.join("\n"));
        }
      } catch { /* skip */ }
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

async function main() {
  if (process.env.DUO_ACTIVE !== "1") {
    process.exit(0);
  }

  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input: HookInput = JSON.parse(chunks.join(""));

  ensureQueues();

  const recentOutput = await extractRecentOutput(input.transcript_path);

  // Send to supervisor as a special "worker stopped" action
  const action = JSON.stringify({
    tool_name: "__worker_stopped__",
    tool_input: { final_output: recentOutput },
    cwd: input.cwd,
    session_id: input.session_id,
    worker_context: recentOutput,
  });

  await writeQueue(getActionQueuePath(), action);

  // Wait for supervisor decision
  const raw = await readQueue(getDecisionQueuePath());
  let decision: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  try {
    decision = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const perm = decision.hookSpecificOutput?.permissionDecision;

  if (perm === "deny") {
    // Supervisor wants to redirect — prevent the stop and inject feedback
    const feedback = decision.hookSpecificOutput?.permissionDecisionReason ?? "";
    const result = JSON.stringify({
      continue: false,
      systemMessage: feedback,
    });
    process.stdout.write(result);
  }
  // If approved or anything else, exit normally (worker stops)
}

main().catch(() => {
  process.exit(1);
});
