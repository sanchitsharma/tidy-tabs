#!/usr/bin/env bash
# Remove what install.sh created: our helper registration in each browser and the tidy-tabs runtime
# folder (it holds only the helper). Logs are kept; delete the log folder yourself if you want them
# gone. macOS and Linux.
#
#   curl -fsSL https://github.com/sanchitsharma/tidy-tabs/releases/latest/download/uninstall.sh | bash
set -euo pipefail

# Runs inside main(), called on the last line, so a cut-off `curl | bash` download runs nothing.
main() {
HOST_NAME="dev.tidytabs.claude"
case "$(uname -s)" in
  Darwin)
    AS="$HOME/Library/Application Support"
    RUNTIME="$AS/tidy-tabs"
    LOG_DIR="$HOME/Library/Logs/tidy-tabs"
    DIRS=(
      "$AS/Google/Chrome" "$AS/Google/Chrome Beta" "$AS/Google/Chrome Dev" "$AS/Google/Chrome Canary"
      "$AS/Chromium" "$AS/BraveSoftware/Brave-Browser" "$AS/Microsoft Edge" "$AS/Vivaldi"
      "$AS/Dia/User Data" "$AS/com.phibrowser.Mac" "$AS/Arc/User Data"
    )
    ;;
  Linux)
    CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
    RUNTIME="${XDG_DATA_HOME:-$HOME/.local/share}/tidy-tabs"
    LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tidy-tabs"
    DIRS=(
      "$CFG/google-chrome" "$CFG/google-chrome-beta" "$CFG/google-chrome-unstable"
      "$CFG/chromium" "$CFG/BraveSoftware/Brave-Browser" "$CFG/microsoft-edge" "$CFG/vivaldi"
    )
    ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
for dir in "${DIRS[@]}"; do
  f="$dir/NativeMessagingHosts/$HOST_NAME.json"
  if [[ -f "$f" ]]; then rm -f "$f"; echo "removed: $f"; fi
done
if [[ -d "$RUNTIME" ]]; then rm -rf "$RUNTIME"; echo "removed: $RUNTIME"; fi
echo "Logs (if any) remain in $LOG_DIR"
}

main "$@"
