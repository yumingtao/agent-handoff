#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_INDEX="$SCRIPT_DIR/dist/index.js"

CLAUDE_DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
CODEX_CONFIG="$HOME/.codex/config.toml"
VSCODE_MCP_CONFIG="$REPO_ROOT/.vscode/mcp.json"
COPILOT_INTELLIJ_CONFIG="$HOME/.config/github-copilot/intellij/mcp.json"
CURSOR_CONFIG="$HOME/.cursor/mcp.json"
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.jsonc"
CLINE_MCP_SETTINGS="$HOME/.cline/data/settings/cline_mcp_settings.json"
HERMES_CONFIG="$HOME/.hermes/config.yaml"
if [[ "$(uname -s)" == "Darwin" ]]; then
  TRAE_IDE_CONFIG="$HOME/Library/Application Support/Trae CN/User/mcp.json"
else
  TRAE_IDE_CONFIG="$HOME/.config/Trae CN/User/mcp.json"
fi
TRAE_CLI_CONFIG="$HOME/.traecli/trae_cli.yaml"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

ALL_PLATFORMS=(claude-code claude-desktop codex copilot-vscode copilot-intellij codebuddy cline cursor opencode hermes trae-ide trae-cli)
DEFAULT_PLATFORMS=(claude-code claude-desktop)
SELECTED_PLATFORMS=()
SKIP_BUILD=false
PLATFORMS_EXPLICIT=false

usage() {
  cat <<EOF
Usage: ./install.sh [options]

Build and configure the Handoff MCP server for local AI platforms.

Options:
  --platforms LIST   Comma-separated platforms to configure.
                     Supported: claude-code, claude-desktop, codex,
                     copilot-vscode, copilot-intellij, codebuddy, cline, cursor, opencode, hermes, trae-ide, trae-cli, all, none
  --all              Configure all supported local platforms.
  --no-build         Skip npm install/build and only update platform configs.
  -h, --help         Show this help.

Examples:
  ./install.sh
  ./install.sh --all
  ./install.sh --platforms claude-code,codex,cursor
  ./install.sh --platforms none --no-build
EOF
}

join_by_comma() {
  local IFS=","
  echo "$*"
}

normalize_platforms() {
  local raw="$1"
  local normalized=()
  raw="${raw//,/ }"

  if [ -z "$raw" ] || [ "$raw" = "none" ]; then
    SELECTED_PLATFORMS=()
    return
  fi

  for item in $raw; do
    case "$item" in
      all)
        normalized=("${ALL_PLATFORMS[@]}")
        ;;
      none)
        normalized=()
        ;;
      claude|claude-code)
        normalized+=(claude-code)
        ;;
      claude-desktop)
        normalized+=(claude-desktop)
        ;;
      codex|codex-cli|codex-desktop)
        normalized+=(codex)
        ;;
      copilot|copilot-vscode|vscode)
        normalized+=(copilot-vscode)
        ;;
      copilot-intellij|copilot-jetbrains|intellij|jetbrains)
        normalized+=(copilot-intellij)
        ;;
      codebuddy)
        normalized+=(codebuddy)
        ;;
      cline)
        normalized+=(cline)
        ;;
      cursor)
        normalized+=(cursor)
        ;;
      opencode)
        normalized+=(opencode)
        ;;
      hermes|hermes-desktop)
        normalized+=(hermes)
        ;;
      trae|trae-ide)
        normalized+=(trae-ide)
        ;;
      trae-cli|traecli)
        normalized+=(trae-cli)
        ;;
      "")
        ;;
      *)
        error "Unknown platform: $item"
        usage
        exit 1
        ;;
    esac
  done

  local unique=()
  local seen=" "
  for item in "${normalized[@]}"; do
    if [[ "$seen" != *" $item "* ]]; then
      unique+=("$item")
      seen+="$item "
    fi
  done

  SELECTED_PLATFORMS=("${unique[@]}")
}

detect_suggested_platforms() {
  local suggested=("${DEFAULT_PLATFORMS[@]}")

  command -v codex &>/dev/null && suggested+=(codex)
  command -v codebuddy &>/dev/null && suggested+=(codebuddy)
  [[ -d "$HOME/.cline" ]] && suggested+=(cline)
  command -v cursor &>/dev/null && suggested+=(cursor)
  command -v opencode &>/dev/null && suggested+=(opencode)
  command -v hermes &>/dev/null && suggested+=(hermes)
  [[ -d "$HOME/.trae-cn" ]] && suggested+=(trae-ide)
  [[ -d "$HOME/.traecli" ]] && suggested+=(trae-cli)
  command -v code &>/dev/null && suggested+=(copilot-vscode)
  if [ -f "$COPILOT_INTELLIJ_CONFIG" ] || find "$HOME/Library/Application Support/JetBrains" -maxdepth 5 -path "*/plugins/github-copilot-intellij" -type d 2>/dev/null | grep -q .; then
    suggested+=(copilot-intellij)
  fi

  local unique=()
  local seen=" "
  for item in "${suggested[@]}"; do
    if [[ "$seen" != *" $item "* ]]; then
      unique+=("$item")
      seen+="$item "
    fi
  done

  echo "${unique[*]}"
}

select_platforms_interactively() {
  if [ "$PLATFORMS_EXPLICIT" = true ] || [ ${#SELECTED_PLATFORMS[@]} -gt 0 ]; then
    return
  fi

  if [ ! -t 0 ]; then
    SELECTED_PLATFORMS=("${DEFAULT_PLATFORMS[@]}")
    return
  fi

  echo ""
  echo "Select platforms to configure:"
  echo "  1) claude-code      Claude Code CLI user scope"
  echo "  2) claude-desktop   Claude Desktop macOS config"
  echo "  3) codex            Codex CLI / IDE extension / Desktop local config"
  echo "  4) copilot-vscode   GitHub Copilot in VS Code workspace config"
  echo "  5) copilot-intellij GitHub Copilot in JetBrains IDEs user config"
  echo "  6) codebuddy        CodeBuddy CLI user scope"
  echo "  7) cline            Cline (VS Code / JetBrains) user config"
  echo "  8) cursor           Cursor user config"
  echo "  9) opencode         OpenCode user config"
  echo " 10) hermes           Hermes Agent config"
  echo " 11) trae-ide         Trae IDE user config"
  echo " 12) trae-cli         Trae CLI user config"
  echo ""
  echo "Enter names separated by comma, or use all/none."

  local suggested
  suggested="$(detect_suggested_platforms)"
  local suggested_csv
  suggested_csv="$(join_by_comma $suggested)"

  read -r -p "Platforms [${suggested_csv}]: " answer
  if [ -z "$answer" ]; then
    normalize_platforms "$suggested"
  else
    normalize_platforms "$answer"
  fi
}

has_platform() {
  local target="$1"
  if [ ${#SELECTED_PLATFORMS[@]} -eq 0 ]; then
    return 1
  fi

  for platform in "${SELECTED_PLATFORMS[@]}"; do
    if [ "$platform" = "$target" ]; then
      return 0
    fi
  done
  return 1
}

require_node() {
  if ! command -v node &>/dev/null; then
    error "node is required but was not found in PATH."
    exit 1
  fi

  local major minor
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; }; then
    error "Node >= 22.5 is required for node:sqlite. Current: $(node --version)"
    exit 1
  fi

  # Pin the ABSOLUTE node path into every platform config. GUI-launched clients
  # (e.g. CodeBuddy/Copilot in JetBrains) resolve a bare "node" against their own
  # PATH, which may point at an older Node (e.g. an nvm v16) that lacks the
  # node:sqlite built-in. That makes the server "connect" but fail on the first
  # tool call with: "No such built-in module: node:sqlite". An absolute path
  # makes the launch independent of the client's PATH.
  NODE_BIN="$(command -v node)"
  if ! "$NODE_BIN" -e 'require("node:sqlite")' &>/dev/null; then
    error "Resolved node ($NODE_BIN) cannot load node:sqlite. Use Node >= 22.5."
    exit 1
  fi
  info "Pinning MCP server command to: $NODE_BIN ($("$NODE_BIN" --version))"
}

build_server() {
  if [ "$SKIP_BUILD" = true ]; then
    info "Skipping npm install/build because --no-build was provided."
  else
    info "Installing dependencies..."
    cd "$SCRIPT_DIR"
    npm install

    info "Building..."
    npm run build
  fi

  if [ ! -f "$DIST_INDEX" ]; then
    error "Build output not found: $DIST_INDEX"
    exit 1
  fi

  info "Build output ready: $DIST_INDEX"
}

handoff_env_json() {
  local dist_index="$1"
  node - "$dist_index" "$NODE_BIN" <<'NODE'
const distIndex = process.argv[2];
const nodeBin = process.argv[3];
console.log(JSON.stringify({
  type: "stdio",
  command: nodeBin,
  args: [distIndex],
  env: {
    AGENT_HANDOFF_HOME: process.env.AGENT_HANDOFF_HOME || "",
    AGENT_HANDOFF_DB_PATH: process.env.AGENT_HANDOFF_DB_PATH || "",
    AGENT_HANDOFF_FILES_DIR: process.env.AGENT_HANDOFF_FILES_DIR || "",
    AGENT_HANDOFF_BACKUPS_DIR: process.env.AGENT_HANDOFF_BACKUPS_DIR || "",
    AGENT_HANDOFF_SECRET_SCAN: process.env.AGENT_HANDOFF_SECRET_SCAN || "1"
  }
}));
NODE
}

json_env_object() {
  cat <<'NODE'
{
  AGENT_HANDOFF_HOME: process.env.AGENT_HANDOFF_HOME || "",
  AGENT_HANDOFF_DB_PATH: process.env.AGENT_HANDOFF_DB_PATH || "",
  AGENT_HANDOFF_FILES_DIR: process.env.AGENT_HANDOFF_FILES_DIR || "",
  AGENT_HANDOFF_BACKUPS_DIR: process.env.AGENT_HANDOFF_BACKUPS_DIR || "",
  AGENT_HANDOFF_SECRET_SCAN: process.env.AGENT_HANDOFF_SECRET_SCAN || "1"
}
NODE
}

configure_claude_code() {
  info "Registering Handoff MCP server with Claude Code CLI (user scope)..."

  if ! command -v claude &>/dev/null; then
    warn "claude CLI not found; skipping Claude Code CLI configuration."
    echo "  Install Claude Code CLI first, then re-run: ./install.sh --platforms claude-code"
    return
  fi

  claude mcp remove agent-handoff -s user 2>/dev/null || true
  claude mcp remove agent-handoff -s user 2>/dev/null || true
  claude mcp add agent-handoff -s user \
    -e "AGENT_HANDOFF_HOME=${AGENT_HANDOFF_HOME:-}" \
    -e "AGENT_HANDOFF_DB_PATH=${AGENT_HANDOFF_DB_PATH:-}" \
    -e "AGENT_HANDOFF_FILES_DIR=${AGENT_HANDOFF_FILES_DIR:-}" \
    -e "AGENT_HANDOFF_BACKUPS_DIR=${AGENT_HANDOFF_BACKUPS_DIR:-}" \
    -e "AGENT_HANDOFF_SECRET_SCAN=${AGENT_HANDOFF_SECRET_SCAN:-1}" \
    -- node "$DIST_INDEX"

  info "Claude Code CLI configured."
}

configure_claude_desktop() {
  info "Configuring Claude Desktop ($CLAUDE_DESKTOP_CONFIG)..."

  mkdir -p "$(dirname "$CLAUDE_DESKTOP_CONFIG")"
  if [ ! -f "$CLAUDE_DESKTOP_CONFIG" ]; then
    echo '{}' > "$CLAUDE_DESKTOP_CONFIG"
  fi

  node - "$CLAUDE_DESKTOP_CONFIG" "$DIST_INDEX" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const distIndex = process.argv[3];
const nodeBin = process.argv[4];

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch {}

if (!config.mcpServers) config.mcpServers = {};
delete config.mcpServers["agent-handoff"];
config.mcpServers["agent-handoff"] = {
  command: nodeBin,
  args: [distIndex],
  env: {
    AGENT_HANDOFF_HOME: process.env.AGENT_HANDOFF_HOME || "",
    AGENT_HANDOFF_DB_PATH: process.env.AGENT_HANDOFF_DB_PATH || "",
    AGENT_HANDOFF_FILES_DIR: process.env.AGENT_HANDOFF_FILES_DIR || "",
    AGENT_HANDOFF_BACKUPS_DIR: process.env.AGENT_HANDOFF_BACKUPS_DIR || "",
    AGENT_HANDOFF_SECRET_SCAN: process.env.AGENT_HANDOFF_SECRET_SCAN || "1"
  }
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
NODE

  info "Claude Desktop configured."
}

configure_codex() {
  info "Configuring Codex ($CODEX_CONFIG)..."

  mkdir -p "$(dirname "$CODEX_CONFIG")"
  touch "$CODEX_CONFIG"

  node - "$CODEX_CONFIG" "$DIST_INDEX" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const distIndex = process.argv[3];
const nodeBin = process.argv[4];
const begin = "# >>> agent-handoff-mcp";
const end = "# <<< agent-handoff-mcp";
const legacyBegin = "# >>> agent-handoff-mcp";
const legacyEnd = "# <<< agent-handoff-mcp";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let current = fs.readFileSync(configPath, "utf8");
const managed = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");
current = current.replace(managed, "").trimEnd();
const legacyManaged = new RegExp(`${escapeRegExp(legacyBegin)}[\\s\\S]*?${escapeRegExp(legacyEnd)}\\n?`, "m");
current = current.replace(legacyManaged, "").trimEnd();

const legacyBlocks = [
  /\n?\[mcp_servers\.agent-handoff\][\s\S]*?(?=\n\[[^\]]+\]|$)/g,
  /\n?\[mcp_servers\.agent-handoff\.env\][\s\S]*?(?=\n\[[^\]]+\]|$)/g,
  /\n?\[mcp_servers\.agent-handoff\][\s\S]*?(?=\n\[[^\]]+\]|$)/g,
  /\n?\[mcp_servers\.agent-handoff\.env\][\s\S]*?(?=\n\[[^\]]+\]|$)/g
];
for (const pattern of legacyBlocks) {
  current = current.replace(pattern, "").trimEnd();
}

const q = (value) => JSON.stringify(value);
const block = [
  begin,
  "# Managed by agent-handoff/server/install.sh",
  "",
  "[mcp_servers.agent-handoff]",
  `command = ${q(nodeBin)}`,
  `args = [${q(distIndex)}]`,
  "enabled = true",
  "",
  "[mcp_servers.agent-handoff.env]",
  `AGENT_HANDOFF_HOME = ${q(process.env.AGENT_HANDOFF_HOME || "")}`,
  `AGENT_HANDOFF_DB_PATH = ${q(process.env.AGENT_HANDOFF_DB_PATH || "")}`,
  `AGENT_HANDOFF_FILES_DIR = ${q(process.env.AGENT_HANDOFF_FILES_DIR || "")}`,
  `AGENT_HANDOFF_BACKUPS_DIR = ${q(process.env.AGENT_HANDOFF_BACKUPS_DIR || "")}`,
  `AGENT_HANDOFF_SECRET_SCAN = ${q(process.env.AGENT_HANDOFF_SECRET_SCAN || "1")}`,
  end,
  ""
].join("\n");

const next = (current ? `${current}\n\n` : "") + block;
fs.writeFileSync(configPath, next);
NODE

  info "Codex configured."
}

configure_json_file() {
  local config_path="$1"
  local root_key="$2"

  mkdir -p "$(dirname "$config_path")"
  if [ ! -f "$config_path" ]; then
    if [ "$root_key" = "servers" ]; then
      echo '{"servers":{}}' > "$config_path"
    else
      echo '{"mcpServers":{}}' > "$config_path"
    fi
  fi

  node - "$config_path" "$DIST_INDEX" "$root_key" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const distIndex = process.argv[3];
const rootKey = process.argv[4];
const nodeBin = process.argv[5];

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    const next = input[i + 1];

    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    output += current;
  }

  return output;
}

function parseJsonc(input) {
  return JSON.parse(stripJsonComments(input).replace(/,\s*([}\]])/g, "$1"));
}

let config = {};
try {
  config = parseJsonc(fs.readFileSync(configPath, "utf-8"));
} catch {}

if (!config[rootKey]) config[rootKey] = {};
delete config[rootKey]["agent-handoff"];
config[rootKey]["agent-handoff"] = {
  type: "stdio",
  command: nodeBin,
  args: [distIndex],
  env: {
    AGENT_HANDOFF_HOME: process.env.AGENT_HANDOFF_HOME || "",
    AGENT_HANDOFF_DB_PATH: process.env.AGENT_HANDOFF_DB_PATH || "",
    AGENT_HANDOFF_FILES_DIR: process.env.AGENT_HANDOFF_FILES_DIR || "",
    AGENT_HANDOFF_BACKUPS_DIR: process.env.AGENT_HANDOFF_BACKUPS_DIR || "",
    AGENT_HANDOFF_SECRET_SCAN: process.env.AGENT_HANDOFF_SECRET_SCAN || "1"
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

configure_opencode() {
  info "Configuring OpenCode ($OPENCODE_CONFIG)..."

  mkdir -p "$(dirname "$OPENCODE_CONFIG")"
  if [ ! -f "$OPENCODE_CONFIG" ]; then
    echo '{"$schema":"https://opencode.ai/config.json","mcp":{}}' > "$OPENCODE_CONFIG"
  fi

  node - "$OPENCODE_CONFIG" "$DIST_INDEX" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const distIndex = process.argv[3];
const nodeBin = process.argv[4];

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    const next = input[i + 1];

    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    output += current;
  }

  return output;
}

function parseJsonc(input) {
  return JSON.parse(stripJsonComments(input).replace(/,\s*([}\]])/g, "$1"));
}

let config = {};
try {
  config = parseJsonc(fs.readFileSync(configPath, "utf-8"));
} catch {}

if (!config.mcp || typeof config.mcp !== "object") config.mcp = {};
delete config.mcp["agent-handoff"];
config.mcp["agent-handoff"] = {
  type: "local",
  enabled: true,
  command: [nodeBin, distIndex],
  env: {
    AGENT_HANDOFF_HOME: "{env:AGENT_HANDOFF_HOME}",
    AGENT_HANDOFF_DB_PATH: "{env:AGENT_HANDOFF_DB_PATH}",
    AGENT_HANDOFF_FILES_DIR: "{env:AGENT_HANDOFF_FILES_DIR}",
    AGENT_HANDOFF_BACKUPS_DIR: "{env:AGENT_HANDOFF_BACKUPS_DIR}",
    AGENT_HANDOFF_SECRET_SCAN: "{env:AGENT_HANDOFF_SECRET_SCAN}"
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

  info "OpenCode configured."
}

configure_hermes() {
  info "Configuring Hermes Agent ($HERMES_CONFIG)..."

  if ! command -v hermes &>/dev/null; then
    warn "hermes CLI not found — configuring config.yaml directly."
  fi

  mkdir -p "$(dirname "$HERMES_CONFIG")"
  touch "$HERMES_CONFIG"

  "$NODE_BIN" - "$HERMES_CONFIG" "$DIST_INDEX" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const distIndex = process.argv[3];
const nodeBin = process.argv[4];

const begin = "# >>> agent-handoff-mcp";
const end = "# <<< agent-handoff-mcp";

let current = "";
try {
  current = fs.readFileSync(configPath, "utf8");
} catch {}

// Remove existing managed block
const managed = new RegExp(
  begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "[\\s\\S]*?" +
  end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "\\n?", "m"
);
current = current.replace(managed, "").trimEnd();

// Remove legacy entry
current = current.replace(/\n? *agent-handoff:[\s\S]*?(?=\n\S|\n *\w+:(?!\s*\n\s)|\s*$)/, "").trimEnd();

// Ensure mcp_servers: top-level key exists
if (!current.includes("mcp_servers:")) {
  current = current ? `${current}\n\nmcp_servers:\n` : "mcp_servers:\n";
}

const home = process.env.AGENT_HANDOFF_HOME || `${process.env.HOME}/.agent-handoff`;
const block = [
  begin,
  "  agent-handoff:",
  `    command: "${nodeBin}"`,
  `    args: ["${distIndex}"]`,
  "    env:",
  `      AGENT_HANDOFF_HOME: "${home}"`,
  `      AGENT_HANDOFF_DB_PATH: "${process.env.AGENT_HANDOFF_DB_PATH || `${home}/handoff.db`}"`,
  `      AGENT_HANDOFF_FILES_DIR: "${process.env.AGENT_HANDOFF_FILES_DIR || `${home}/files`}"`,
  `      AGENT_HANDOFF_BACKUPS_DIR: "${process.env.AGENT_HANDOFF_BACKUPS_DIR || `${home}/backups`}"`,
  `      AGENT_HANDOFF_SECRET_SCAN: "${process.env.AGENT_HANDOFF_SECRET_SCAN || "1"}"`,
  "  " + end,
  ""
].join("\n");

// Insert the block after mcp_servers:
const insertPos = current.indexOf("mcp_servers:");
const afterKey = current.indexOf("\n", insertPos);
const before = current.slice(0, afterKey + 1);
const after = current.slice(afterKey + 1);
const next = `${before}${block}${after}`.trimEnd() + "\n";

fs.writeFileSync(configPath, next);
NODE

  info "Hermes Agent configured."
}

configure_vscode_copilot() {
  info "Configuring GitHub Copilot in VS Code ($VSCODE_MCP_CONFIG)..."
  configure_json_file "$VSCODE_MCP_CONFIG" servers
  info "VS Code Copilot workspace MCP config updated."
}

configure_intellij_copilot() {
  info "Configuring GitHub Copilot in JetBrains IDEs ($COPILOT_INTELLIJ_CONFIG)..."
  configure_json_file "$COPILOT_INTELLIJ_CONFIG" servers
  info "JetBrains Copilot MCP config updated."
}

configure_codebuddy() {
  info "Configuring CodeBuddy..."

  if ! command -v codebuddy &>/dev/null; then
    warn "codebuddy CLI not found; skipping CodeBuddy configuration."
    echo "  Install CodeBuddy first, then re-run: ./install.sh --platforms codebuddy"
    return
  fi

  local handoff_json
  handoff_json="$(handoff_env_json "$DIST_INDEX")"

  codebuddy mcp remove --scope user agent-handoff 2>/dev/null || true
  codebuddy mcp remove --scope user agent-handoff 2>/dev/null || true

  if ! codebuddy mcp add-json --scope user agent-handoff "$handoff_json"; then
    warn "CodeBuddy Handoff MCP registration failed."
  fi

  info "CodeBuddy configuration attempted."
}

configure_cline() {
  info "Configuring Cline ($CLINE_MCP_SETTINGS)..."
  configure_json_file "$CLINE_MCP_SETTINGS" mcpServers

  # Post-write safety check: Cline does NOT expand shell variables at runtime.
  # All env vars must be resolved at install time. Abort if any literal '${' leaked.
  if grep -q '${' "$CLINE_MCP_SETTINGS" 2>/dev/null; then
    error "Cline MCP config contains unresolved '\${' placeholders!"
    error "File: $CLINE_MCP_SETTINGS"
    error "This means env vars were not expanded at install time. Fix configure_json_file."
    exit 1
  fi

  info "Cline configured."
}

configure_cursor() {
  info "Configuring Cursor ($CURSOR_CONFIG)..."
  configure_json_file "$CURSOR_CONFIG" mcpServers
  info "Cursor configured."
}

configure_trae_ide() {
  info "Configuring Trae IDE ($TRAE_IDE_CONFIG)..."
  configure_json_file "$TRAE_IDE_CONFIG" mcpServers
  info "Trae IDE configured."
}

configure_trae_cli() {
  info "Configuring Trae CLI ($TRAE_CLI_CONFIG)..."

  mkdir -p "$(dirname "$TRAE_CLI_CONFIG")"
  touch "$TRAE_CLI_CONFIG"

  "$NODE_BIN" - "$TRAE_CLI_CONFIG" "$DIST_INDEX" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const distIndex = process.argv[3];
const nodeBin = process.argv[4];

const begin = "# >>> agent-handoff-mcp";
const end = "# <<< agent-handoff-mcp";

let current = "";
try {
  current = fs.readFileSync(configPath, "utf8");
} catch {}

// Remove existing managed block
const managed = new RegExp(
  begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "[\\s\\S]*?" +
  end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "\\n?", "m"
);
current = current.replace(managed, "").trimEnd();

// Ensure mcp_servers: top-level key exists
if (!current.includes("mcp_servers:")) {
  current = current ? `${current}\n\nmcp_servers:\n` : "mcp_servers:\n";
}

const home = process.env.AGENT_HANDOFF_HOME || `${process.env.HOME}/.agent-handoff`;
const block = [
  begin,
  `  - name: "agent-handoff"`,
  `    type: stdio`,
  `    command: "${nodeBin}"`,
  `    args: ["${distIndex}"]`,
  `    env:`,
  `      AGENT_HANDOFF_HOME: "${home}"`,
  `      AGENT_HANDOFF_DB_PATH: "${process.env.AGENT_HANDOFF_DB_PATH || `${home}/handoff.db`}"`,
  `      AGENT_HANDOFF_FILES_DIR: "${process.env.AGENT_HANDOFF_FILES_DIR || `${home}/files`}"`,
  `      AGENT_HANDOFF_BACKUPS_DIR: "${process.env.AGENT_HANDOFF_BACKUPS_DIR || `${home}/backups`}"`,
  `      AGENT_HANDOFF_SECRET_SCAN: "${process.env.AGENT_HANDOFF_SECRET_SCAN || "1"}"`,
  end,
  ""
].join("\n");

// Insert the block after mcp_servers:
const insertPos = current.indexOf("mcp_servers:");
const afterKey = current.indexOf("\n", insertPos);
const before = current.slice(0, afterKey + 1);
const after = current.slice(afterKey + 1);
const next = `${before}${block}${after}`.trimEnd() + "\n";

fs.writeFileSync(configPath, next);
NODE

  info "Trae CLI configured."
}

print_next_steps() {
  local configured="none"
  if [ ${#SELECTED_PLATFORMS[@]} -gt 0 ]; then
    configured="$(join_by_comma "${SELECTED_PLATFORMS[@]}")"
  fi

  echo ""
  info "Installation complete!"
  echo ""
  echo "Configured platforms: $configured"
  echo ""
  echo "Next steps:"
  echo "  - Restart or reload the selected AI clients."
  echo "  - Start with health_check, then publish_conclusion or get_latest_conclusion."
  echo ""
  echo "Handoff stores context only. next_action is a suggested action, not authorization."
  echo "Keep tokens, cookies, private keys, and customer-sensitive data out of handoff records."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --platforms)
      if [ $# -lt 2 ]; then
        error "--platforms requires a value"
        exit 1
      fi
      PLATFORMS_EXPLICIT=true
      normalize_platforms "$2"
      shift 2
      ;;
    --all)
      PLATFORMS_EXPLICIT=true
      normalize_platforms all
      shift
      ;;
    --no-build)
      SKIP_BUILD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

require_node
select_platforms_interactively
build_server

has_platform claude-code && configure_claude_code
has_platform claude-desktop && configure_claude_desktop
has_platform codex && configure_codex
has_platform copilot-vscode && configure_vscode_copilot
has_platform copilot-intellij && configure_intellij_copilot
has_platform codebuddy && configure_codebuddy
has_platform cline && configure_cline
has_platform cursor && configure_cursor
has_platform opencode && configure_opencode
has_platform hermes && configure_hermes
has_platform trae-ide && configure_trae_ide
has_platform trae-cli && configure_trae_cli

print_next_steps
