#!/usr/bin/env node

/**
 * DuoCode MCP Server
 *
 * Exposes tools to the supervisor Claude Code:
 *   - review_next_action: blocks until a worker tool call arrives via queue
 *   - approve: unblocks the worker hook with "allow"
 *   - deny: unblocks the worker hook with "deny" + feedback
 *   - ask_user: escalates to the human user's permission dialog
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import {
  getActionQueuePath,
  getAnswerQueuePath,
  getDecisionQueuePath,
  getDuoDir,
  getQuestionQueuePath,
  readQueue,
  writeQueue,
} from "../queue.js";

// Don't recreate queues — the CLI already created them.
// Just signal readiness.
fs.writeFileSync(path.join(getDuoDir(), "ready"), String(process.pid));

const logFile = path.join(getDuoDir(), "mcp.log");
function log(msg: string): void {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
}

let hasPendingAction = false;

const server = new McpServer({
  name: "duo-mcp",
  version: "1.0.0",
});

// --- review_next_action ---
server.tool(
  "review_next_action",
  "Wait for the next worker tool call to review. Blocks until the worker proposes an action. Returns the tool name, input, and worker context since last review.",
  {},
  async () => {
    hasPendingAction = false;

    const raw = await readQueue(getActionQueuePath());
    let action: Record<string, unknown>;
    try {
      action = JSON.parse(raw);
    } catch {
      return {
        content: [{ type: "text" as const, text: `Failed to parse action JSON: ${raw}` }],
        isError: true,
      };
    }
    hasPendingAction = true;

    const toolName = (action.tool_name as string) || "unknown";
    log(`review_next_action: received tool=${toolName}`);
    const toolInput = action.tool_input || {};
    const workerContext = (action.worker_context as string) || "";

    let text = "";
    if (workerContext) {
      text += `## Worker context since last review\n\n${workerContext}\n\n---\n\n`;
    }

    if (toolName === "__worker_stopped__") {
      text += `## Worker has stopped\n\n`;
      text += `The worker finished and is waiting for your decision.\n\n`;
      text += `- Call **approve** if the task is complete\n`;
      text += `- Call **deny** with feedback to redirect the worker (it will keep working)\n`;
    } else {
      text += `## Proposed action\n\n`;
      text += `**Tool:** ${toolName}\n`;
      text += `**Input:**\n\`\`\`json\n${JSON.stringify(toolInput, null, 2)}\n\`\`\`\n`;
    }

    return { content: [{ type: "text" as const, text }] };
  }
);

// --- approve ---
server.tool(
  "approve",
  "Approve the pending worker action. The worker will proceed with the tool call.",
  { reason: z.string().describe("Why you're approving this action") },
  async ({ reason }) => {
    if (!hasPendingAction) {
      return {
        content: [{ type: "text" as const, text: "No pending action to approve. Call review_next_action first." }],
        isError: true,
      };
    }

    const decision = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: `Supervisor approved: ${reason}`,
      },
    });

    log(`approve: ${reason}`);
    await writeQueue(getDecisionQueuePath(), decision);
    hasPendingAction = false;

    return {
      content: [{ type: "text" as const, text: `Approved. Reason: ${reason}\n\nCall review_next_action to wait for the next action.` }],
    };
  }
);

// --- deny ---
server.tool(
  "deny",
  "Reject the pending tool call with feedback. The worker will see your feedback and adjust.",
  {
    feedback: z.string().describe("Why you're denying and what to do instead"),
  },
  async ({ feedback }) => {
    if (!hasPendingAction) {
      return {
        content: [{ type: "text" as const, text: "No pending action to deny. Call review_next_action first." }],
        isError: true,
      };
    }

    const decision = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Supervisor denied: ${feedback}`,
      },
    });

    log(`deny: ${feedback}`);
    await writeQueue(getDecisionQueuePath(), decision);
    hasPendingAction = false;

    return {
      content: [{ type: "text" as const, text: `Denied: ${feedback}\n\nCall review_next_action to wait for the next action.` }],
    };
  }
);

// --- guide_worker ---
server.tool(
  "guide_worker",
  "Redirect the worker with new instructions. Use when the worker stopped but isn't done, or when you want to change its direction without denying a specific action.",
  {
    feedback: z.string().describe("Detailed guidance — what to do next, what direction to take"),
  },
  async ({ feedback }) => {
    if (!hasPendingAction) {
      return {
        content: [{ type: "text" as const, text: "No pending action. Call review_next_action first." }],
        isError: true,
      };
    }

    const decision = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Supervisor guidance: ${feedback}`,
      },
    });

    await writeQueue(getDecisionQueuePath(), decision);
    hasPendingAction = false;

    return {
      content: [{ type: "text" as const, text: `Guided worker: ${feedback}\n\nCall review_next_action to wait for the next action.` }],
    };
  }
);

// --- ask_user ---
// Sends question to the CLI (via question queue) or WhatsApp, waits for answer.
server.tool(
  "ask_user",
  "Ask the human user a question and wait for their reply. Use sparingly — only for true blockers like ambiguous requirements or high-stakes decisions. The question is sent to the user's terminal (with an audio ping) and optionally via WhatsApp.",
  {
    question: z.string().describe("The question to ask the user"),
    timeout_minutes: z.number().optional().describe("How long to wait for a reply (default: 5)"),
  },
  async ({ question, timeout_minutes }) => {
    const timeoutMs = (timeout_minutes ?? 5) * 60_000;

    // Send question through the queue — the CLI will display it and collect the answer
    await writeQueue(getQuestionQueuePath(), JSON.stringify({ question, timeoutMs }));

    // Wait for answer
    const answer = await readQueue(getAnswerQueuePath());

    return {
      content: [{ type: "text" as const, text: `User replied: ${answer}\n\nCall review_next_action to continue reviewing actions.` }],
    };
  }
);

// --- escalate_to_user ---
// Falls through to normal Claude Code permission dialog (no supervisor decision)
server.tool(
  "escalate_to_user",
  "Let the user decide on the pending action directly via Claude Code's normal permission dialog, bypassing the supervisor.",
  { reason: z.string().describe("Why this needs the user's direct decision") },
  async ({ reason }) => {
    if (!hasPendingAction) {
      return {
        content: [{ type: "text" as const, text: "No pending action to escalate. Call review_next_action first." }],
        isError: true,
      };
    }

    const decision = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Supervisor escalated to user: ${reason}`,
      },
    });

    await writeQueue(getDecisionQueuePath(), decision);
    hasPendingAction = false;

    return {
      content: [{ type: "text" as const, text: `Escalated to user's permission dialog. Reason: ${reason}\n\nCall review_next_action to wait for the next action.` }],
    };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
