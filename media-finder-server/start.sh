#!/bin/bash
# Starts media-finder-server in the background, detached from this terminal.
# Stop it later with: lsof -ti:3000 | xargs kill
set -e

cd "$(dirname "$0")"

if lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "media-finder-server already running on port 3000."
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "node_modules is missing. Run 'npm install' in media-finder-server first." >&2
  exit 1
fi

if [ ! -f bin/yt-dlp ]; then
  echo "bin/yt-dlp is missing. Run 'npm run setup:yt-dlp' in media-finder-server first." >&2
  exit 1
fi

nohup npm run dev > server.log 2>&1 &
disown

echo "media-finder-server starting in the background (PID $!)."
echo "Logs: $(pwd)/server.log"
