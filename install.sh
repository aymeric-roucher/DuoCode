#!/usr/bin/env bash
set -euo pipefail

# DuoCode Installer
# Installs the DuoCode CLI and hooks

DUO_DIR="${HOME}/.claude/hooks/duo"
SETTINGS_FILE="${HOME}/.claude/settings.json"
INSTALL_DIR="${HOME}/.local/share/duocode"
BIN_DIR="${HOME}/.local/bin"
REPO_URL="https://github.com/aymeric-roucher/DuoCode"

echo ""
echo "  ╭──────────────────────────────╮"
echo "  │      DuoCode Installer       │"
echo "  ╰──────────────────────────────╯"
echo ""

# 1. Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  echo "  Downloading DuoCode..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 2. Install dependencies
echo "  Installing dependencies..."
npm install --quiet 2>/dev/null

# 3. Create duo directory
mkdir -p "$DUO_DIR"

if [ ! -f "$DUO_DIR/state.json" ]; then
  echo '{"active": false}' > "$DUO_DIR/state.json"
fi

# 4. Create the hook runner
cat > "$DUO_DIR/hook.sh" << HOOKEOF
#!/usr/bin/env bash
exec npx --prefix "$INSTALL_DIR" tsx "$INSTALL_DIR/src/hooks/pre-tool-use.ts"
HOOKEOF
chmod +x "$DUO_DIR/hook.sh"

# 5. Write MCP config for the supervisor
cat > "$DUO_DIR/mcp-config.json" << MCPEOF
{
  "mcpServers": {
    "duo": {
      "command": "npx",
      "args": ["--prefix", "$INSTALL_DIR", "tsx", "$INSTALL_DIR/src/mcp/server.ts"],
      "env": { "DUO_DIR": "$DUO_DIR" }
    }
  }
}
MCPEOF

# 6. Register PreToolUse hook in Claude Code settings
echo "  Registering hook..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

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
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
"

# 7. Install the `duo` CLI binary
echo "  Installing CLI..."
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/duo" << BINEOF
#!/usr/bin/env bash
exec npx --prefix "$INSTALL_DIR" tsx "$INSTALL_DIR/src/cli.ts" "\$@"
BINEOF
chmod +x "$BIN_DIR/duo"

# 8. Check PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "  ⚠  Add $BIN_DIR to your PATH:"
  echo "     export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

echo ""
echo "  ✓ DuoCode installed"
echo ""
echo "  Usage:"
echo "    duo                — start interactive session with supervisor"
echo "    duo \"fix the bug\" — run with a prompt"
echo "    duo stop           — stop the supervisor"
echo "    duo status         — check supervisor status"
echo ""
echo "  Uses your existing Claude Code credentials. No extra API key needed."
echo ""
