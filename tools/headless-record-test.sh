#!/usr/bin/env bash
# Prove the note_detect recording pipeline (browser capture -> WAV) with no
# human and no guitar. See headless-record-test.js for the why.
#
#   tools/headless-record-test.sh                  # against http://localhost:8000
#   SLOP_URL=http://host:8000 tools/headless-record-test.sh
#   REC_DIR=/path/to/static/note_detect_recordings tools/headless-record-test.sh
#
# Needs Playwright + Chromium. We don't add it to the plugin's deps (keeps the
# shipped plugin lean); this resolves an install in priority order and prints
# the one command to create one if none is found.
#
# Env:
#   SLOP_URL         slopsmith base URL                     (default http://localhost:8000)
#   FAKE_WAV         16-bit PCM WAV fed as the mic          (auto-generated if absent)
#   REC_DIR          host recordings dir to assert the WAV  (optional; enables the on-disk check)
#   PLAYWRIGHT_DIRS  ':'-separated dirs to search for a Playwright install,
#                    tried before the built-in defaults
set -euo pipefail
cd "$(dirname "$0")"

FAKE_WAV="${FAKE_WAV:-/tmp/fakemic.wav}"
export FAKE_WAV SLOP_URL="${SLOP_URL:-http://localhost:8000}"
[ -n "${REC_DIR:-}" ] && export REC_DIR

# 1. Fake-mic WAV (12s 110Hz tone, 48k/16-bit) — regenerate if absent.
if [ ! -f "$FAKE_WAV" ]; then
    command -v ffmpeg >/dev/null || { echo "need ffmpeg to make $FAKE_WAV"; exit 2; }
    ffmpeg -y -f lavfi -i "sine=frequency=110:duration=12" -ar 48000 -ac 2 -sample_fmt s16 "$FAKE_WAV" >/dev/null 2>&1
fi

# 2. Resolve a Playwright install. Project-relative first, then any caller-
#    supplied PLAYWRIGHT_DIRS, then a couple of conventional fallbacks. First
#    install that actually contains the `playwright` package wins.
SEARCH=("$PWD/.headless")
if [ -n "${PLAYWRIGHT_DIRS:-}" ]; then
    IFS=':' read -r -a EXTRA <<< "$PLAYWRIGHT_DIRS"
    SEARCH+=("${EXTRA[@]}")
fi
SEARCH+=("/tmp/headless-rec")
for dir in "${SEARCH[@]}"; do
    if [ -d "$dir/node_modules/playwright" ]; then export NODE_PATH="$dir/node_modules"; break; fi
done
if [ -z "${NODE_PATH:-}" ]; then
    cat <<EOF
Playwright not found in: ${SEARCH[*]}
Create a local install once (kept out of the plugin via .gitignore):
    mkdir -p "$PWD/.headless" && cd "$PWD/.headless" \\
      && npm init -y >/dev/null && npm i playwright && npx playwright install chromium
Or point PLAYWRIGHT_DIRS at an existing install. Then re-run this script.
EOF
    exit 3
fi

echo "Playwright: $NODE_PATH   URL: $SLOP_URL   mic: $FAKE_WAV${REC_DIR:+   rec-dir: $REC_DIR}"
exec node headless-record-test.js
