#!/usr/bin/env bash
# Download the latest successful Android debug APK artifact from the
# GitHub Actions android-build.yml workflow, and (optionally) install
# it onto a connected Android device via `adb install`.
#
# The APK is signed with the committed debug keystore, so it installs on
# any device with "Install unknown apps" enabled, and `adb install -r`
# upgrades in place across CI builds.
#
# Required tools (provided by shell.nix):
#   - gh  (GitHub CLI; run `gh auth login` once)
# Optional: adb (android-tools) for auto-install over USB.
#
# Usage:
#   ./install-android.sh                     # download + auto-install if adb + device available
#   APK_OUT=~/dsh.apk ./install-android.sh   # save APK to a custom path
#   APK_KEEP=1 ./install-android.sh          # keep the temp work dir for inspection
#
# Exit codes: 0 = success, non-zero = something failed (message on stderr).

set -euo pipefail

WORKFLOW="android-build.yml"
ARTIFACT_NAME="dsh-debug-apk"
DEFAULT_APK_OUT="${PWD}/DSH.apk"
APK_OUT="${APK_OUT:-$DEFAULT_APK_OUT}"

# Temp dir cleanup unless APK_KEEP=1 is set (debugging).
WORK_DIR="$(mktemp -d)"
cleanup() {
  if [ -z "${APK_KEEP:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

# ── Preflight ─────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) not found." >&2
  echo "  Add to shell.nix: pkgs.gh" >&2
  echo "  Then run: gh auth login" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# ── Find latest successful run ────────────────────────────────────
echo "→ Looking up latest successful run of $WORKFLOW..."
RUN_ID="$(gh run list \
  --workflow="$WORKFLOW" \
  --status=success \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId' \
  || true)"
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "error: no successful runs of $WORKFLOW found." >&2
  echo "  Trigger one via the GitHub Actions tab, then re-run this script." >&2
  exit 1
fi
RUN_INFO="$(gh run view "$RUN_ID" --json displayTitle,headSha,createdAt --jq '"\(.displayTitle) · \(.headSha[0:7]) · \(.createdAt)"' || echo "$RUN_ID")"
echo "  run: $RUN_INFO"

# ── Download artifact ─────────────────────────────────────────────
echo "→ Downloading $ARTIFACT_NAME..."
gh run download "$RUN_ID" -n "$ARTIFACT_NAME" --dir "$WORK_DIR"

APK_SRC="$(find "$WORK_DIR" -maxdepth 2 -name "*.apk" | head -1)"
if [ -z "$APK_SRC" ] || [ ! -f "$APK_SRC" ]; then
  echo "error: no .apk found in artifact contents:" >&2
  find "$WORK_DIR" -type f >&2
  exit 1
fi

mkdir -p "$(dirname "$APK_OUT")"
cp "$APK_SRC" "$APK_OUT"
echo "  saved: $APK_OUT  ($(du -h "$APK_OUT" | cut -f1))"

# ── Optional: install via adb ─────────────────────────────────────
if ! command -v adb >/dev/null 2>&1; then
  cat <<EOF

APK ready. Next step: install onto your Android phone.

  Quickest manual path:
    1. Transfer the APK to your phone (Syncthing / USB / cloud / Drive).
    2. On the phone, tap the APK file.
    3. Approve "Install unknown apps" for whatever browsed-it (Files,
       Drive, etc.) and tap Install.

  Auto-install over USB: install adb (android-tools), enable USB
  debugging on the phone (Settings → About → tap Build Number 7×,
  then Settings → System → Developer Options → USB debugging), plug
  in via cable, and re-run this script.
EOF
  exit 0
fi

# Detect connected devices. `adb devices` first line is a header,
# subsequent lines are "<id>\t<state>". We want devices whose state
# is "device" (not "unauthorized" or "offline").
DEVICES="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
DEVICE_COUNT="$(echo -n "$DEVICES" | grep -c . || true)"

if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo
  echo "No connected Android device found via adb."
  echo "  - Plug the phone in via USB."
  echo "  - On the phone, allow USB debugging when prompted."
  echo "  - Then re-run this script, OR transfer $APK_OUT manually and tap to install."
  exit 0
fi

if [ "$DEVICE_COUNT" -gt 1 ]; then
  echo
  echo "Multiple Android devices connected — pick one with ANDROID_SERIAL:"
  echo "$DEVICES" | sed 's/^/  /'
  echo "Then re-run: ANDROID_SERIAL=<id> ./install-android.sh"
  exit 0
fi

DEVICE="$(echo "$DEVICES" | head -1)"
echo "→ Phone: $DEVICE"
echo "→ Installing $APK_OUT..."
# `-r` reinstalls keeping data; `-d` allows version downgrade so a
# stale local APK doesn't refuse to install over a newer copy on the
# device. Useful when iterating between branches.
adb -s "$DEVICE" install -r -d "$APK_OUT"
echo "✓ Done. Launch DSH from the app drawer."
