#!/usr/bin/env bash
# Regenerate the Android launcher-icon PNGs from the SVG sources in
# mobile/assets/icon/. Requires rsvg-convert (e.g. `nix shell nixpkgs#librsvg`).
#
#   assets/icon/icon.svg            → mipmap-*/ic_launcher.png       (square, legacy)
#   assets/icon/icon-round.svg      → mipmap-*/ic_launcher_round.png (circle, legacy)
#   assets/icon/icon-foreground.svg → mipmap-*/ic_launcher_foreground.png
#                                     (transparent, used by the adaptive icon
#                                      on API 26+ over @color/ic_launcher_background)
#
# The adaptive-icon XML (mipmap-anydpi-v26/ic_launcher*.xml) and the
# background color (values/colors.xml ic_launcher_background, #141A26) are
# checked in as-is — keep them in sync if you change the background here.

set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MOBILE_DIR"

RES=android/app/src/main/res

# density → launcher size (px) / foreground size (px)
for entry in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  IFS=: read -r density launcher foreground <<<"$entry"
  mkdir -p "$RES/mipmap-$density"
  rsvg-convert -w "$launcher"   -h "$launcher"   assets/icon/icon.svg            -o "$RES/mipmap-$density/ic_launcher.png"
  rsvg-convert -w "$launcher"   -h "$launcher"   assets/icon/icon-round.svg      -o "$RES/mipmap-$density/ic_launcher_round.png"
  rsvg-convert -w "$foreground" -h "$foreground" assets/icon/icon-foreground.svg -o "$RES/mipmap-$density/ic_launcher_foreground.png"
done

echo "Regenerated launcher icons under $RES/mipmap-*/"
