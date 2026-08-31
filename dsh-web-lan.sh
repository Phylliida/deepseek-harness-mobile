#!/usr/bin/env bash
# Launch the DeepSeek Harness Web GUI bound to the LAN (all interfaces).
#
# The GUI has NO authentication: anyone on the network who opens the URL can
# drive the agent with shell access. Run only on a trusted network.
#
# Usage: ./dsh-web-lan.sh [extra dsh args...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY="$SCRIPT_DIR/lan.overlay.yml"
CHECKOUT="/home/bepis/prog/deepseek-harness-mobile"

if [[ ! -f "$OVERLAY" ]]; then
  echo "error: overlay not found: $OVERLAY" >&2
  exit 1
fi

# The overlay pins port 3081; refuse to start a duplicate.
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:3081/; then
  echo "dsh web LAN instance already running:" >&2
  echo "  http://127.0.0.1:3081  (local)" >&2
  echo "  http://$(ip -4 addr show scope global | grep -oP 'inet \K[\d.]+' | head -1):3081  (LAN)" >&2
  exit 1
fi

cd "$CHECKOUT"
exec pnpm dsh --profile web --patch "$OVERLAY" "$@"
