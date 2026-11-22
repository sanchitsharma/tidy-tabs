#!/usr/bin/env bash
# Install the Tidy Tabs AI helper: the native messaging host that lets the extension use Claude
# through your local Claude Code CLI. macOS and Linux.
#
#   Without a clone:  curl -fsSL https://github.com/sanchitsharma/tidy-tabs/releases/latest/download/install.sh | bash
#   From a clone:     ./install.sh [--claude /abs/path/to/claude] [--node /abs/path/to/node] [--extension-id ID]
#
# It copies the helper to a per-user folder, writes a small launcher with absolute paths (browsers
# start helpers with a minimal PATH), and registers it with every supported browser it finds.
# Nothing is installed system-wide and no sudo is needed. Undo with uninstall.sh.
set -euo pipefail

HOST_NAME="dev.tidytabs.claude"
# Chrome Web Store ID of Tidy Tabs AI. extension/manifest.json carries the store's public key, so an
# unpacked copy of extension/ gets this same ID.
STORE_EXTENSION_ID="__STORE_EXTENSION_ID__"
RELEASE_BASE="${TIDY_RELEASE_BASE:-https://github.com/sanchitsharma/tidy-tabs/releases/latest/download}"

CLAUDE_BIN="" NODE_BIN=""
EXTRA_IDS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude) CLAUDE_BIN="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --extension-id) EXTRA_IDS+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin)
    AS="$HOME/Library/Application Support"
    RUNTIME_DIR="$AS/tidy-tabs/native-host" # outside ~/Documents: macOS privacy (TCC) blocks helpers there
    LOG_DIR="$HOME/Library/Logs/tidy-tabs"
    BROWSER_DIRS=(
      "$AS/Google/Chrome" "$AS/Google/Chrome Beta" "$AS/Google/Chrome Dev" "$AS/Google/Chrome Canary"
      "$AS/Chromium" "$AS/BraveSoftware/Brave-Browser" "$AS/Microsoft Edge" "$AS/Vivaldi"
      "$AS/Dia/User Data" "$AS/com.phibrowser.Mac"
    )
    ;;
  Linux)
    CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
    RUNTIME_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tidy-tabs/native-host"
    LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tidy-tabs"
    BROWSER_DIRS=(
      "$CFG/google-chrome" "$CFG/google-chrome-beta" "$CFG/google-chrome-unstable"
      "$CFG/chromium" "$CFG/BraveSoftware/Brave-Browser" "$CFG/microsoft-edge" "$CFG/vivaldi"
    )
    ;;
  *)
    echo "Tidy Tabs AI's Claude helper supports macOS and Linux only (this is $(uname -s))." >&2
    echo "On other systems, use the Ollama or built-in Gemini Nano backend in the extension's Options." >&2
    exit 1
    ;;
esac

# Where the helper's files come from: this checkout, or the latest GitHub release.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
TMP=""
cleanup() { if [[ -n "$TMP" ]]; then rm -rf "$TMP"; fi; } # must not change the exit status
trap cleanup EXIT
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/native-host/host.js" ]]; then
  SRC="$SCRIPT_DIR/native-host"
  echo "Installing the helper from this checkout: $SRC"
else
  command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
  TMP="$(mktemp -d)"
  echo "Downloading the helper from $RELEASE_BASE ..."
  curl -fsSL "$RELEASE_BASE/native-host.tar.gz" -o "$TMP/native-host.tar.gz"
  tar -xzf "$TMP/native-host.tar.gz" -C "$TMP"
  SRC="$TMP/native-host"
  [[ -f "$SRC/host.js" ]] || { echo "download did not contain native-host/host.js" >&2; exit 1; }
fi

# First real executable named $1: login shells (zsh, bash) first, then this shell's PATH, skipping
# wrapper shims that live in temp dirs (e.g. cmux).
resolve() {
  local name="$1" p
  while IFS= read -r p; do
    [[ -z "$p" || "$p" == */cmux-cli-shims/* || "$p" == /var/folders/* || "$p" == /private/var/folders/* ]] && continue
    [[ -x "$p" ]] && { echo "$p"; return 0; }
  done < <(
    {
      command -v zsh >/dev/null && zsh -lc "whence -ap $name"
      bash -lc "type -ap $name"
      type -ap "$name"
    } 2>/dev/null
  )
  return 1
}
[[ -n "$CLAUDE_BIN" ]] || CLAUDE_BIN="$(resolve claude || true)"
[[ -n "$CLAUDE_BIN" ]] || { [[ -x "$HOME/.local/bin/claude" ]] && CLAUDE_BIN="$HOME/.local/bin/claude"; } || true
[[ -n "$NODE_BIN" ]] || NODE_BIN="$(resolve node || true)"
if [[ ! -x "$CLAUDE_BIN" ]]; then
  echo "Claude Code CLI ('claude') not found. Install it (https://docs.anthropic.com/en/docs/claude-code)," >&2
  echo "run 'claude' once to log in, then re-run this installer (or pass --claude /abs/path)." >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js not found. Install Node 18 or newer, then re-run (or pass --node /abs/path)." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node $NODE_MAJOR is too old; the helper needs Node 18 or newer ($NODE_BIN)." >&2
  exit 1
fi

# Extensions allowed to talk to the helper: the store ID, the ID from a checkout's manifest key (the
# same ID once the store key is in the manifest), and any --extension-id given.
IDS=()
[[ "$STORE_EXTENSION_ID" =~ ^[a-p]{32}$ ]] && IDS+=("$STORE_EXTENSION_ID")
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/extension/manifest.json" && -f "$SRC/extension-id.js" ]]; then
  KEY_ID="$("$NODE_BIN" "$SRC/extension-id.js" "$SCRIPT_DIR/extension/manifest.json" 2>/dev/null || true)"
  [[ -n "$KEY_ID" ]] && IDS+=("$KEY_ID")
fi
IDS+=("${EXTRA_IDS[@]+"${EXTRA_IDS[@]}"}")
ORIGINS=""
SEEN=" "
for id in "${IDS[@]+"${IDS[@]}"}"; do
  [[ "$id" =~ ^[a-p]{32}$ ]] || { echo "ignoring invalid extension id: $id" >&2; continue; }
  [[ "$SEEN" == *" $id "* ]] && continue
  SEEN+="$id "
  ORIGINS+="${ORIGINS:+, }\"chrome-extension://$id/\""
done
[[ -n "$ORIGINS" ]] || { echo "no extension id to allow; pass --extension-id" >&2; exit 1; }

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"
for f in host.js claude.js framing.js logfile.js package.json; do
  command cp -f "$SRC/$f" "$RUNTIME_DIR/$f"
done

# Launcher. Shell-quote every interpolated path (printf %q) so spaces/quotes can't break it.
WRAPPER="$RUNTIME_DIR/tidy-tabs-host"
Q_CLAUDE="$(printf '%q' "$CLAUDE_BIN")"
Q_NODE="$(printf '%q' "$NODE_BIN")"
Q_HOSTJS="$(printf '%q' "$RUNTIME_DIR/host.js")"
Q_LOGS="$(printf '%q' "$LOG_DIR")"
cat > "$WRAPPER" <<WRAP
#!/bin/bash
# Generated by Tidy Tabs AI's install.sh. Browsers spawn this with a minimal PATH, so paths are absolute.
TIDY_CLAUDE_BIN=$Q_CLAUDE
TIDY_LOG_DIR=$Q_LOGS
export TIDY_CLAUDE_BIN TIDY_LOG_DIR
LOGS=\$TIDY_LOG_DIR
mkdir -p "\$LOGS" 2>/dev/null
# Keep the launcher's own logs small: past 1000 lines, keep the last 500.
for f in "\$LOGS/host-starts.log" "\$LOGS/host-stderr.log"; do
  if [ -f "\$f" ] && [ "\$(wc -l < "\$f")" -gt 1000 ]; then
    tail -n 500 "\$f" > "\$f.tmp" 2>/dev/null && mv "\$f.tmp" "\$f"
  fi
done
echo "\$(date -u +%FT%TZ) start ppid=\$PPID caller=\$(ps -o comm= -p \$PPID 2>/dev/null)" >> "\$LOGS/host-starts.log" 2>/dev/null
exec $Q_NODE $Q_HOSTJS "\$@" 2>>"\$LOGS/host-stderr.log"
WRAP
chmod 755 "$WRAPPER"

# JSON-escape the launcher path (backslashes and quotes) for the host manifest.
J_WRAPPER="${WRAPPER//\\/\\\\}"
J_WRAPPER="${J_WRAPPER//\"/\\\"}"
MANIFEST_JSON="{
  \"name\": \"$HOST_NAME\",
  \"description\": \"Tidy Tabs AI: Claude via the local Claude Code CLI\",
  \"path\": \"$J_WRAPPER\",
  \"type\": \"stdio\",
  \"allowed_origins\": [$ORIGINS]
}"

installed=0
for browser_dir in "${BROWSER_DIRS[@]}"; do
  if [[ -d "$browser_dir" ]]; then
    mkdir -p "$browser_dir/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST_JSON" > "$browser_dir/NativeMessagingHosts/$HOST_NAME.json"
    echo "registered: $browser_dir/NativeMessagingHosts/$HOST_NAME.json"
    installed=$((installed + 1))
  fi
done

# Arc is no longer supported (macOS): remove only our own manifest there, nothing else.
ARC_OURS="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts/$HOST_NAME.json"
if [[ -f "$ARC_OURS" ]]; then rm -f "$ARC_OURS"; echo "removed old Arc manifest: $ARC_OURS"; fi

echo
echo "helper:  $WRAPPER"
echo "claude:  $CLAUDE_BIN"
echo "node:    $NODE_BIN"
echo "logs:    $LOG_DIR"
echo "allowed: $ORIGINS"
if [[ $installed -eq 0 ]]; then
  echo "No supported browser profile found. Open Chrome (or Chromium, Brave, Edge, Vivaldi) once, then re-run." >&2
  exit 1
fi
echo
echo "Done. Fully quit and reopen your browser so it picks up the helper,"
echo "then click the Tidy Tabs AI toolbar icon and press Tidy now."
