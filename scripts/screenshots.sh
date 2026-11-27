#!/bin/sh
# Regenerates docs/screenshots from the preview pages (macOS: needs Google Chrome and sips).
# Headless Chrome has a 500 px minimum viewport, so pages fix the sidebar width on <body>
# and the screenshot is cropped to that width.
set -e
cd "$(dirname "$0")/.."
npm run preview:build >/dev/null
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT=docs/screenshots
mkdir -p "$OUT"
shoot() { # page output css-width css-height
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
        --window-size=500,"$4" --screenshot="$OUT/$2.full.png" "file://$PWD/preview/$1" >/dev/null 2>&1
    sips --cropOffset 1 1 -c $(($4 * 2)) $(($3 * 2)) "$OUT/$2.full.png" --out "$OUT/$2" >/dev/null
    rm -f "$OUT/$2.full.png"
}
shoot sidebar-dark.html sidebar-dark.png 340 1720
shoot sidebar-light.html sidebar-light.png 340 1720
shoot sidebar-details-dark.html sidebar-details-dark.png 340 1330
shoot sidebar-narrow-dark.html sidebar-narrow-dark.png 230 1500
shoot sidebar-zh-light.html sidebar-zh-light.png 340 1100
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,1500 \
    --screenshot="$OUT/dashboard-dark.png" "file://$PWD/preview/index.html" >/dev/null 2>&1
echo "Screenshots written to $OUT"
