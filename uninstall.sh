#!/usr/bin/env bash
# Remove only what install.sh created: our host manifest in each browser dir (same list as install.sh,
# plus the old Arc location) and the runtime copy in ~/Library/Application Support/tidy-tabs/.
# Logs in ~/Library/Logs/tidy-tabs/ are kept; delete that folder yourself if you want them gone.
set -euo pipefail
HOST_NAME="dev.tidytabs.claude"
AS="$HOME/Library/Application Support"
for dir in \
  "$AS/Google/Chrome" \
  "$AS/Dia/User Data" \
  "$AS/com.phibrowser.Mac" \
  "$AS/Chromium" \
  "$AS/Arc/User Data"; do
  f="$dir/NativeMessagingHosts/$HOST_NAME.json"
  if [[ -f "$f" ]]; then rm -f "$f"; echo "removed: $f"; fi
done
RUNTIME="$AS/tidy-tabs"
if [[ -d "$RUNTIME" ]]; then rm -rf "$RUNTIME"; echo "removed: $RUNTIME"; fi
echo "Logs (if any) remain in $HOME/Library/Logs/tidy-tabs/"
