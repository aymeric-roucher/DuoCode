/**
 * DuoCode Prompt Box
 *
 * A terminal text input box shown when `duo` is launched without a prompt.
 * Replicates Claude Code's prompt input style: a rounded-border box with
 * the ❯ prompt character, multiline editing, bracketed paste, and image
 * file path detection.
 *
 * Keys:
 *   Enter             → submit
 *   Shift+Enter       → newline  (kitty/CSI u protocol)
 *   Alt+Enter         → newline
 *   Backslash+Enter   → newline  (consumes the backslash)
 *   Escape            → skip (launch without prompt)
 *   Ctrl+C            → clear input / exit if empty
 *   Arrow keys        → cursor movement
 *   Ctrl+A / Ctrl+E   → home / end of line
 *   Ctrl+K / Ctrl+U   → kill to end / start of line
 *   Ctrl+W            → kill word back
 */

import fs from "fs";
import path from "path";

// ── ANSI helpers ──

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const H_RULE = "─";

// Claude Code uses figures.pointer (❯) as the prompt char
const PROMPT_CHAR = "❯";

const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
]);

// ── Types ──

export interface PromptResult {
  text: string;
  images: string[];
}

// ── Helpers ──

function isImagePath(filePath: string): boolean {
  try {
    const clean = filePath.replace(/^['"]|['"]$/g, "").trim();
    return IMAGE_EXTS.has(path.extname(clean).toLowerCase()) && fs.existsSync(clean);
  } catch {
    return false;
  }
}

interface WrapResult {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

/**
 * Word-wrap `text` to `width` columns and locate cursor within the result.
 */
function wrapWithCursor(
  text: string,
  cursor: number,
  width: number,
): WrapResult {
  const lines: string[] = [];
  let charPos = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  let found = false;

  const rawLines = text.split("\n");

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;

    // ── empty logical line ──
    if (rawLine.length === 0) {
      if (!found && cursor <= charPos) {
        cursorLine = lines.length;
        cursorCol = 0;
        found = true;
      }
      lines.push("");
      if (i < rawLines.length - 1) charPos++; // count the \n
      continue;
    }

    // ── word-wrap one logical line ──
    let remaining = rawLine;

    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;

      if (!found && cursor >= charPos && cursor <= charPos + breakAt) {
        cursorLine = lines.length;
        cursorCol = cursor - charPos;
        found = true;
      }

      lines.push(remaining.slice(0, breakAt));

      charPos += breakAt;
      remaining = remaining.slice(breakAt);
      if (remaining[0] === " ") {
        charPos++; // consumed space
        remaining = remaining.slice(1);
      }
    }

    // last visual segment of this logical line
    if (!found && cursor >= charPos && cursor <= charPos + remaining.length) {
      cursorLine = lines.length;
      cursorCol = cursor - charPos;
      found = true;
    }

    lines.push(remaining);
    charPos += remaining.length;
    if (i < rawLines.length - 1) charPos++; // \n
  }

  if (!found) {
    cursorLine = Math.max(0, lines.length - 1);
    cursorCol = lines.length > 0 ? lines[lines.length - 1]!.length : 0;
  }

  return { lines, cursorLine, cursorCol };
}

// ── Main ──

export function showPromptBox(): Promise<PromptResult | null> {
  return new Promise<PromptResult | null>((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    if (!stdin.isTTY) {
      resolve(null);
      return;
    }

    // ── Terminal setup ──
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    stdout.write("\x1b[?2004h"); // enable bracketed paste
    stdout.write("\x1b[?25h"); // show cursor

    // ── State ──
    let text = "";
    let cursor = 0;
    let images: string[] = [];
    let isPasting = false;
    let pasteBuffer = "";
    let prevHeight = 0;
    let cursorBoxLine = 0; // which box line the cursor sits on (0 = top border)

    const cols = stdout.columns || 80;
    const ruleWidth = cols - 2;         // full width minus 1-char margin each side
    const prefixLen = 2;                // "❯ " on first line, "  " on continuation
    const textWidth = ruleWidth - prefixLen;
    const maxVisible = 15;

    // ── Text editing primitives ──

    function insertText(s: string) {
      text = text.slice(0, cursor) + s + text.slice(cursor);
      cursor += s.length;
    }

    function backspace() {
      if (cursor > 0) {
        text = text.slice(0, cursor - 1) + text.slice(cursor);
        cursor--;
      }
    }

    function deleteChar() {
      if (cursor < text.length) {
        text = text.slice(0, cursor) + text.slice(cursor + 1);
      }
    }

    function moveLeft() { if (cursor > 0) cursor--; }
    function moveRight() { if (cursor < text.length) cursor++; }

    function moveHome() {
      const before = text.slice(0, cursor);
      cursor = before.lastIndexOf("\n") + 1;
    }

    function moveEnd() {
      const idx = text.indexOf("\n", cursor);
      cursor = idx === -1 ? text.length : idx;
    }

    function moveUp() {
      const before = text.slice(0, cursor);
      const lineStart = before.lastIndexOf("\n") + 1;
      const col = cursor - lineStart;
      if (lineStart === 0) return;
      const prevLineStart = before.lastIndexOf("\n", lineStart - 2) + 1;
      const prevLineLen = lineStart - 1 - prevLineStart;
      cursor = prevLineStart + Math.min(col, prevLineLen);
    }

    function moveDown() {
      const nextNl = text.indexOf("\n", cursor);
      if (nextNl === -1) return;
      const before = text.slice(0, cursor);
      const lineStart = before.lastIndexOf("\n") + 1;
      const col = cursor - lineStart;
      const nextLineStart = nextNl + 1;
      const nextLineEnd = text.indexOf("\n", nextLineStart);
      const nextLineLen = (nextLineEnd === -1 ? text.length : nextLineEnd) - nextLineStart;
      cursor = nextLineStart + Math.min(col, nextLineLen);
    }

    function killToEnd() {
      const nl = text.indexOf("\n", cursor);
      text = text.slice(0, cursor) + text.slice(nl === -1 ? text.length : nl);
    }

    function killToStart() {
      const before = text.slice(0, cursor);
      const start = before.lastIndexOf("\n") + 1;
      text = text.slice(0, start) + text.slice(cursor);
      cursor = start;
    }

    function killWordBack() {
      let j = cursor - 1;
      while (j > 0 && text[j - 1] === " ") j--;
      while (j > 0 && text[j - 1] !== " " && text[j - 1] !== "\n") j--;
      text = text.slice(0, j) + text.slice(cursor);
      cursor = j;
    }

    // ── Paste handling ──

    function processPaste(pasted: string) {
      const tokens = pasted.trim().split(/\s+/);
      const imgPaths: string[] = [];
      const textTokens: string[] = [];

      for (const tok of tokens) {
        const clean = tok.replace(/^['"]|['"]$/g, "");
        if (isImagePath(clean)) {
          imgPaths.push(path.resolve(clean));
        } else {
          textTokens.push(tok);
        }
      }

      if (imgPaths.length > 0) images.push(...imgPaths);
      if (textTokens.length > 0) insertText(textTokens.join(" "));
    }

    // ── Render ──

    function render() {
      const { lines, cursorLine, cursorCol } = text
        ? wrapWithCursor(text, cursor, textWidth)
        : { lines: [""], cursorLine: 0, cursorCol: 0 };

      // Viewport (scroll to keep cursor visible)
      let viewStart = 0;
      if (lines.length > maxVisible) {
        viewStart = Math.max(0, cursorLine - Math.floor(maxVisible / 2));
        viewStart = Math.min(viewStart, lines.length - maxVisible);
      }
      const visible = lines.slice(viewStart, viewStart + maxVisible);
      const adjCursorLine = cursorLine - viewStart;

      // Image attachment lines
      const imgLines = images.map((img) => `📎 ${path.basename(img)}`);

      // ── Build box lines ──
      const boxLines: string[] = [];

      // Top rule
      boxLines.push(` ${DIM}${H_RULE.repeat(ruleWidth)}${RESET}`);

      // Content lines with ❯ prefix on first, spaces on continuation
      if (!text && images.length === 0) {
        // Empty state: show prompt char only
        boxLines.push(` ${CYAN}${PROMPT_CHAR}${RESET} `);
      } else {
        for (let idx = 0; idx < visible.length; idx++) {
          const line = visible[idx]!;
          const isFirst = idx === 0 && viewStart === 0;
          const prefix = isFirst ? `${CYAN}${PROMPT_CHAR}${RESET} ` : "  ";
          boxLines.push(` ${prefix}${line}`);
        }
      }

      // Image attachments
      for (const imgLine of imgLines) {
        boxLines.push(` ${DIM}${imgLine}${RESET}`);
      }

      // Bottom rule
      boxLines.push(` ${DIM}${H_RULE.repeat(ruleWidth)}${RESET}`);

      const totalHeight = boxLines.length;

      // ── Write to terminal ──
      let buf = "";

      // Move to top of previous render
      if (cursorBoxLine > 0) buf += `\x1b[${cursorBoxLine}A`;
      buf += "\r";

      // Draw all lines
      for (const line of boxLines) {
        buf += `\x1b[2K${line}\n`;
      }

      // Clear leftover lines from previous taller render
      const extra = prevHeight - totalHeight;
      if (extra > 0) {
        for (let i = 0; i < extra; i++) buf += `\x1b[2K\n`;
        buf += `\x1b[${extra}A`;
      }

      // Position terminal cursor inside the box
      // Target box line: 1 (top border) + adjCursorLine
      const targetBoxLine = 1 + adjCursorLine;
      const linesUp = totalHeight - targetBoxLine;
      if (linesUp > 0) buf += `\x1b[${linesUp}A`;
      // Column: 1 (margin) + 2 (prefix "❯ " or "  ") + cursorCol  (1-indexed)
      buf += `\r\x1b[${4 + cursorCol}G`;

      stdout.write(buf);

      cursorBoxLine = targetBoxLine;
      prevHeight = totalHeight;
    }

    // ── Cleanup & resolve ──

    function cleanup() {
      stdout.write("\x1b[?2004l"); // disable bracketed paste
      stdout.write("\x1b[?25h");
      stdin.setRawMode(!!wasRaw);
      stdin.removeListener("data", onData);
      stdin.pause();

      // Move cursor to after the box
      const toBottom = prevHeight - cursorBoxLine;
      if (toBottom > 0) stdout.write(`\x1b[${toBottom}B`);
      stdout.write("\r\n");
    }

    function submit() {
      cleanup();
      const trimmed = text.trim();
      resolve(trimmed || images.length > 0 ? { text: trimmed, images } : null);
    }

    function skip() {
      cleanup();
      resolve(null);
    }

    // ── Key parser ──

    function onData(raw: string) {
      let i = 0;

      while (i < raw.length) {
        // ── Bracketed paste markers ──
        if (raw.startsWith("\x1b[200~", i)) {
          isPasting = true;
          pasteBuffer = "";
          i += 6;
          continue;
        }
        if (raw.startsWith("\x1b[201~", i)) {
          isPasting = false;
          if (pasteBuffer) processPaste(pasteBuffer);
          pasteBuffer = "";
          i += 6;
          render();
          continue;
        }
        if (isPasting) {
          pasteBuffer += raw[i];
          i++;
          continue;
        }

        const ch = raw.charCodeAt(i);

        // Ctrl+C
        if (ch === 3) {
          if (text.length > 0) {
            text = "";
            cursor = 0;
            images = [];
            i++;
            render();
            continue;
          }
          // empty → exit
          cleanup();
          process.exit(130);
          return;
        }

        // Ctrl+D on empty
        if (ch === 4 && text.length === 0) {
          skip();
          return;
        }

        // Enter / Return
        if (ch === 13 || ch === 10) {
          // Backslash + Enter → newline (consume the backslash)
          if (cursor > 0 && text[cursor - 1] === "\\") {
            text = text.slice(0, cursor - 1) + "\n" + text.slice(cursor);
            i++;
            render();
            continue;
          }
          submit();
          return;
        }

        // ── Escape sequences ──
        if (ch === 27) {
          // CSI sequence (ESC [)
          if (i + 1 < raw.length && raw[i + 1] === "[") {
            const rest = raw.slice(i + 2);

            // Shift+Enter — kitty protocol: ESC[13;2u
            if (rest.startsWith("13;2u")) {
              insertText("\n");
              i += 7;
              render();
              continue;
            }

            // Shift+Enter — xterm modified: ESC[27;2;13~
            if (rest.startsWith("27;2;13~")) {
              insertText("\n");
              i += 10;
              render();
              continue;
            }

            // Arrow Up
            if (rest.startsWith("A")) {
              moveUp(); i += 3; render(); continue;
            }
            // Arrow Down
            if (rest.startsWith("B")) {
              moveDown(); i += 3; render(); continue;
            }
            // Arrow Right
            if (rest.startsWith("C")) {
              moveRight(); i += 3; render(); continue;
            }
            // Arrow Left
            if (rest.startsWith("D")) {
              moveLeft(); i += 3; render(); continue;
            }
            // Home
            if (rest.startsWith("H")) {
              moveHome(); i += 3; render(); continue;
            }
            // End
            if (rest.startsWith("F")) {
              moveEnd(); i += 3; render(); continue;
            }
            // Delete (ESC[3~)
            if (rest.startsWith("3~")) {
              deleteChar(); i += 4; render(); continue;
            }

            // Ctrl+Left (word back): ESC[1;5D
            if (rest.startsWith("1;5D")) {
              let j = cursor - 1;
              while (j > 0 && text[j - 1] === " ") j--;
              while (j > 0 && text[j - 1] !== " " && text[j - 1] !== "\n") j--;
              cursor = Math.max(0, j);
              i += 6;
              render();
              continue;
            }

            // Ctrl+Right (word forward): ESC[1;5C
            if (rest.startsWith("1;5C")) {
              let j = cursor;
              while (j < text.length && text[j] !== " " && text[j] !== "\n") j++;
              while (j < text.length && text[j] === " ") j++;
              cursor = j;
              i += 6;
              render();
              continue;
            }

            // Skip unknown CSI — scan for final byte (0x40–0x7E)
            let j = 0;
            while (j < rest.length && !(rest.charCodeAt(j) >= 0x40 && rest.charCodeAt(j) <= 0x7e)) {
              j++;
            }
            i += 2 + j + (j < rest.length ? 1 : 0);
            continue;
          }

          // Alt+Enter (ESC CR or ESC LF) → newline
          if (
            i + 1 < raw.length &&
            (raw.charCodeAt(i + 1) === 13 || raw.charCodeAt(i + 1) === 10)
          ) {
            insertText("\n");
            i += 2;
            render();
            continue;
          }

          // Bare Escape (nothing else in this chunk) → skip prompt
          if (i + 1 >= raw.length) {
            skip();
            return;
          }

          // ESC + other: skip ESC, let next char be parsed
          i++;
          continue;
        }

        // Backspace (DEL 0x7F or BS 0x08)
        if (ch === 127 || ch === 8) {
          backspace(); i++; render(); continue;
        }

        // Ctrl+A → home
        if (ch === 1) { moveHome(); i++; render(); continue; }
        // Ctrl+E → end
        if (ch === 5) { moveEnd(); i++; render(); continue; }
        // Ctrl+K → kill to end of line
        if (ch === 11) { killToEnd(); i++; render(); continue; }
        // Ctrl+U → kill to start of line
        if (ch === 21) { killToStart(); i++; render(); continue; }
        // Ctrl+W → kill word back
        if (ch === 23) { killWordBack(); i++; render(); continue; }
        // Tab → insert two spaces
        if (ch === 9) { insertText("  "); i++; render(); continue; }

        // ── Printable characters ──
        if (ch >= 32) {
          // Consume a run of printable chars (handles multi-byte / surrogate pairs)
          let end = i + 1;
          while (end < raw.length) {
            const c = raw.charCodeAt(end);
            if (c < 32 || c === 127 || c === 27) break;
            end++;
          }
          insertText(raw.slice(i, end));
          i = end;
          render();
          continue;
        }

        // Skip other control chars
        i++;
      }
    }

    // ── Start ──
    stdin.on("data", onData);
    render();
  });
}
