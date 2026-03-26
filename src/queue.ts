/**
 * Queue — FIFO-based IPC between the PreToolUse hook and the MCP server.
 *
 * Two named pipes:
 *   action.queue  — hook writes proposed action, MCP server reads (blocks)
 *   decision.queue — MCP server writes decision, hook reads (blocks)
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

export function ensureQueue(queuePath: string): void {
  if (!fs.existsSync(queuePath)) {
    execSync(`mkfifo "${queuePath}"`);
  }
}

export function ensureQueues(): void {
  const dir = getDuoDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ensureQueue(getActionQueuePath());
  ensureQueue(getDecisionQueuePath());
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

/** Write to a named pipe. Blocks until a reader opens the other end. */
export function writeQueue(queuePath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(queuePath, fs.constants.O_WRONLY);
    fs.writeFile(fd, data, "utf-8", (err) => {
      fs.closeSync(fd);
      if (err) reject(err);
      else resolve();
    });
  });
}
