/**
 * Queue — FIFO-based IPC between the PreToolUse hook and the MCP server.
 *
 * Named pipes:
 *   action.queue   — hook writes proposed action, MCP server reads
 *   decision.queue — MCP server writes decision, hook reads
 *   question.queue — MCP server writes user question, CLI reads
 *   answer.queue   — CLI writes user answer, MCP server reads
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export function getDuoDir(): string {
  return process.env.DUO_DIR || path.join(process.env.HOME!, ".claude", "hooks", "duo");
}

export function getActionQueuePath(): string {
  return path.join(getDuoDir(), "action.queue");
}

export function getDecisionQueuePath(): string {
  return path.join(getDuoDir(), "decision.queue");
}

export function getQuestionQueuePath(): string {
  return path.join(getDuoDir(), "question.queue");
}

export function getAnswerQueuePath(): string {
  return path.join(getDuoDir(), "answer.queue");
}

function ensureFifo(fifoPath: string): void {
  // Always recreate to clear stale readers/writers from previous sessions
  try { fs.unlinkSync(fifoPath); } catch { /* doesn't exist */ }
  execSync(`mkfifo "${fifoPath}"`);
}

export function ensureQueues(): void {
  const dir = getDuoDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ensureFifo(getActionQueuePath());
  ensureFifo(getDecisionQueuePath());
  ensureFifo(getQuestionQueuePath());
  ensureFifo(getAnswerQueuePath());
}

/** Read from a named pipe. Blocks until a writer writes and closes. */
export function readQueue(queuePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(queuePath, fs.constants.O_RDONLY);
    const chunks: string[] = [];
    const stream = fs.createReadStream(null as unknown as fs.PathLike, {
      fd,
      encoding: "utf-8",
    });
    stream.on("data", (chunk) => chunks.push(chunk as string));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

/**
 * Write to a named pipe using O_NONBLOCK + retry.
 * If no reader is ready yet, retries every pollMs until one appears.
 */
export async function writeQueue(
  queuePath: string,
  data: string,
  pollMs = 100,
  timeoutMs = 300000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(queuePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.writeFileSync(fd, data, "utf-8");
      fs.closeSync(fd);
      return;
    } catch (err: unknown) {
      // ENXIO = no reader yet, retry
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENXIO") {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`writeQueue timeout: no reader after ${timeoutMs}ms`);
}
