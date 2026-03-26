#!/usr/bin/env bash
set -euo pipefail

# DuoCode Installer
# Installs the DuoCode supervisor system into ~/.claude/hooks/duo/

DUO_DIR="${HOME}/.claude/hooks/duo"
SETTINGS_FILE="${HOME}/.claude/settings.json"
SKILLS_DIR="${HOME}/.claude/skills"
REPO_URL="https://github.com/aymeric-roucher/DuoCode"

echo "=== DuoCode Installer ==="
echo ""

# 1. Clone or update the repo
INSTALL_DIR="${HOME}/.local/share/duocode"
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  echo "Downloading DuoCode..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 2. Install dependencies
echo "Installing dependencies..."
npm install --quiet 2>/dev/null

# 3. Create DuoCode directory
mkdir -p "$DUO_DIR"

# 4. Write state file (inactive by default)
if [ ! -f "$DUO_DIR/state.json" ]; then
  echo '{"active": false}' > "$DUO_DIR/state.json"
fi

# 5. Create the hook runner script (thin wrapper that calls tsx)
cat > "$DUO_DIR/hook.sh" << 'HOOKEOF'
#!/usr/bin/env bash
# DuoCode PreToolUse hook — delegates to the TypeScript implementation
INSTALL_DIR="${HOME}/.local/share/duocode"
exec npx --prefix "$INSTALL_DIR" tsx "$INSTALL_DIR/src/hooks/pre-tool-use.ts"
HOOKEOF
chmod +x "$DUO_DIR/hook.sh"

# 6. Write MCP config for the supervisor
cat > "$DUO_DIR/mcp-config.json" << MCPEOF
{
  "mcpServers": {
    "duo": {
      "command": "npx",
      "args": ["--prefix", "$INSTALL_DIR", "tsx", "$INSTALL_DIR/src/mcp/server.ts"],
      "env": {
        "DUO_DIR": "$DUO_DIR"
      }
    }
  }
}
MCPEOF

# 7. Register hooks in Claude Code settings
echo "Registering hooks in Claude Code settings..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Use node to safely merge hooks into settings.json
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

// Check if DuoCode hook already registered
const hookCmd = '$DUO_DIR/hook.sh';
const existing = settings.hooks.PreToolUse.find(h =>
  h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('duo'))
);

if (!existing) {
  settings.hooks.PreToolUse.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: hookCmd,
      timeout: 60000
    }]
  });
  console.log('  Hook registered.');
} else {
  console.log('  Hook already registered.');
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
"

# 8. Install skills (slash commands)
echo "Installing slash commands..."
mkdir -p "$SKILLS_DIR"

cat > "$SKILLS_DIR/duo-start.md" << 'SKILLEOF'
---
name: duo-start
description: Start the DuoCode supervisor to review tool calls
user_invocable: true
---

Start the DuoCode supervisor. Run this command:

\`\`\`bash
cd ~/.local/share/duocode && npx tsx src/cli.ts start
\`\`\`

Then tell the user: "DuoCode supervisor is now active. All tool calls (except reads) will be reviewed before execution."
SKILLEOF

cat > "$SKILLS_DIR/duo-stop.md" << 'SKILLEOF'
---
name: duo-stop
description: Stop the DuoCode supervisor
user_invocable: true
---

Stop the DuoCode supervisor. Run this command:

\`\`\`bash
cd ~/.local/share/duocode && npx tsx src/cli.ts stop
\`\`\`

Then tell the user: "DuoCode supervisor stopped. Tool calls will use normal permission mode."
SKILLEOF

cat > "$SKILLS_DIR/duo-status.md" << 'SKILLEOF'
---
name: duo-status
description: Check DuoCode supervisor status
user_invocable: true
---

Check DuoCode supervisor status. Run this command:

\`\`\`bash
cd ~/.local/share/duocode && npx tsx src/cli.ts status
\`\`\`

Report the result to the user.
SKILLEOF

echo ""
echo "=== Installation complete ==="
echo ""
echo "Usage:"
echo "  duocode start   — start the supervisor (or use /duo-start in Claude Code)"
echo "  duocode stop    — stop the supervisor (or use /duo-stop)"
echo "  duocode status  — check status (or use /duo-status)"
echo ""
echo "The supervisor uses your existing Claude Code credentials."
echo "No additional API key needed."
