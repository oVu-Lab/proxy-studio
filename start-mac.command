#!/bin/bash
cd "$(dirname "$0")" || exit 1
printf '\n  Proxy Studio — local AI gateway\n\n'
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Node.js 20.9 or newer is required. Install it from https://nodejs.org, then double-click this file again.'
  read -r -p 'Press Return to close...'
  exit 1
fi
if [ ! -d node_modules/next ]; then
  echo 'Installing dependencies for first launch...'
  npm install || { echo 'Installation failed.'; read -r -p 'Press Return to close...'; exit 1; }
fi
PORT="${PORT:-8088}"
export PORT
(
  for _ in {1..180}; do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      open "http://127.0.0.1:${PORT}"
      break
    fi
    sleep 1
  done
) &
npm start
read -r -p 'Server stopped. Press Return to close...'
